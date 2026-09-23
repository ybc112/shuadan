import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { defaultConfig, defaultRisk, riskSchema, robotSchema } from '../shared/config';
import type { AppState, AuditEvent, ExecutionMode, Fill, LiveAccount, LiveStatus, Market, MarketSource, Order, QuoteAccount, QuoteAsset, RiskSettings, Robot, RobotConfig, Summary } from '../shared/types';
import { D, floorStep, gridLevels, makerPrice, midPrice, openingNotional, orderQuantity, positionAfterFill, positionNotional, unrealized, validMarket, worstPosition } from './math';
import { sampleMarkets } from './markets';
import { ActionBudget } from './rate-limit';
import type { BinanceTradingClient, FuturesOrder, UserTrade } from './binance-trading';
import type { EquitySnapshot, TradeRecord } from './trade-log';

export interface PersistedState {
  version: 1;
  execution: ExecutionMode;
  source: MarketSource;
  wallets: Record<QuoteAsset, string>;
  markets: Market[];
  robots: Robot[];
  fills: Fill[];
  events: AuditEvent[];
  settings: RiskSettings;
  emergencyStopped: boolean;
  stopReason: string;
  day: string;
  dailyStartEquity: string;
  peakEquity: string;
  totalFees: string;
  totalFilledNotional: string;
  liveAccount: LiveAccount | null;
  liveStatus: LiveStatus | null;
}

export type LiveBroker = BinanceTradingClient;

/**
 * 引擎对成交流水只依赖这个窄接口：便于测试注入，也避免引擎直接耦合 node:sqlite。
 * record() 返回 false 表示该笔已存在（按 id 去重）。
 */
export interface TradeLogLike {
  setRobotName(robotId: string, name: string): void;
  record(trade: TradeRecord): boolean;
  recordEquity(snapshot: EquitySnapshot): void;
}

export class MakerEngine {
  source: MarketSource = 'binance';
  execution: ExecutionMode = 'paper';
  executionStatus: AppState['executionStatus'] = 'idle';
  executionMessage = '未启用实盘';
  markets: Market[];
  robots: Robot[] = [];
  orders: Order[] = [];
  fills: Fill[] = [];
  events: AuditEvent[] = [];
  settings: RiskSettings = { ...defaultRisk };
  wallets: Record<QuoteAsset, string> = { USDT: '0', USDC: '0' };
  emergencyStopped = false;
  stopReason = '';
  feed: AppState['feed'];
  liveAccount: LiveAccount | null = null;
  liveStatus: LiveStatus | null = null;
  private day: string;
  dailyStartEquity = '0';
  peakEquity = '0';
  private totalFees = '0';
  private totalFilledNotional = '0';
  private budget = new ActionBudget();
  private lastMatched = new Map<string, number>();
  private lastNotice = new Map<string, number>();
  private lastAccountSync = 0;
  private lastTradeSync = 0;
  private lastOrderSync = 0;
  // 已发出但尚未在币安落地的撤单数（按 symbol）。撤单是异步的：不等它落地就挂新单，
  // 新单会与被撤掉前仍挂在交易所的旧单自成交，被币安以 -5022 拒掉（实测 8 分钟 7 次）。
  private pendingCancels = new Map<string, number>();
  // 上一次实际生效的库存偏斜步长（按机器人），用于判断持仓变化是否需要重挂网格
  private lastSkew = new Map<string, number>();
  // 机器人进入只减仓的起始时间（按机器人），用于 exitTimeoutSeconds 超时后升级为跨价成交
  private reduceSince = new Map<string, number>();
  // Cached live exchange identifiers so we can cancel our orders later.
  private liveOrderMeta = new Map<string, { orderId: string; clientOrderId: string; symbol: string }>();
  private liveBroker: LiveBroker | null = null;
  private liveSwitchInFlight = false;
  private lastTradesBySymbol = new Map<string, number>();
  // 外部资金变动校准（入金/出金）。币安钱包余额变化 = 入金 + 已实现盈亏 + 手续费（返佣为负），
  // 引擎对成交部分有精确的 realizedPnl/fees 累计，两者之差即「非交易资金流」。
  // 若直接拿「当前余额 - 日内基准」当 dailyPnl，转入本金会被错记为当日盈利（实测 9-20 入金 40U
  // 后 dailyPnl 虚增 +40）。把非交易资金流同步进 dailyStartEquity/peakEquity，让指标只反映交易结果。
  // 阈值 1U 规避资金费率/BNB 抵扣等小幅噪声；live 切换（rebaseline）后重建基线。
  private lastWalletSeen: Decimal | null = null;
  private lastRealizedSeen: Decimal | null = null;
  private lastFeesSeen: Decimal | null = null;
  // 独立成交流水（SQLite）。为 null 时引擎行为完全不变，便于测试与纸面运行。
  private tradeLog: TradeLogLike | null = null;

  constructor(saved?: PersistedState, now = Date.now()) {
    this.markets = [];
    this.day = new Date(now).toISOString().slice(0, 10);
    this.feed = { status: 'connecting', message: '正在连接币安公开行情…', updatedAt: 0 };
    if (saved) {
      this.execution = saved.execution ?? 'paper';
      this.source = saved.source;
      this.wallets = saved.wallets;
      this.markets = saved.markets;
      this.robots = saved.robots.map(r => ({ ...r, status: 'paused', lastQuoteAt: 0, reason: '服务重启已暂停；持仓已保留，请复核后启动' }));
      this.fills = saved.fills;
      this.events = saved.events;
      this.settings = saved.settings;
      this.emergencyStopped = saved.emergencyStopped;
      this.stopReason = saved.stopReason;
      this.day = saved.day;
      this.dailyStartEquity = saved.dailyStartEquity;
      this.peakEquity = saved.peakEquity;
      this.totalFees = saved.totalFees;
      this.totalFilledNotional = saved.totalFilledNotional;
      this.liveAccount = saved.liveAccount ?? null;
      this.liveStatus = saved.liveStatus ?? null;
      this.feed = { status: 'connecting', message: '等待新的行情快照，机器人已暂停', updatedAt: 0 };
      this.log('warning', 'system', '已恢复账户、持仓和日志；所有机器人暂停，未恢复旧挂单', undefined, now);
    } else {
      this.log('info', 'system', '已连接币安公开行情；未创建示例机器人，请创建策略后启动。', undefined, now);
    }
  }

  attachLiveBroker(broker: LiveBroker | null) { this.liveBroker = broker; this.liveStatus = broker ? broker.status() : null; }

  market(symbol: string): Market {
    const market = this.markets.find(m => m.symbol === symbol);
    if (!market) throw new Error(`没有 ${symbol} 的有效合约行情`);
    return market;
  }

  robot(id: string): Robot {
    const robot = this.robots.find(r => r.id === id);
    if (!robot) throw new Error('机器人不存在');
    return robot;
  }

  log(level: AuditEvent['level'], category: AuditEvent['category'], message: string, robot?: Robot, now = Date.now()) {
    this.events.unshift({ id: randomUUID(), time: now, level, category, message, robotId: robot?.id, symbol: robot?.symbol });
    this.events = this.events.slice(0, 600);
  }

  private notice(key: string, message: string, robot: Robot, now: number) {
    if (now - (this.lastNotice.get(key) ?? 0) >= 60000) {
      this.log('warning', 'risk', message, robot, now);
      this.lastNotice.set(key, now);
    }
  }

  accounts(): QuoteAccount[] {
    if (this.execution === 'live' && this.liveAccount) {
      const live = this.liveAccount;
      const wallets = live.assets.filter(a => ['USDT', 'USDC'].includes(a.asset));
      const accounts: QuoteAccount[] = (['USDC', 'USDT'] as QuoteAsset[]).map(asset => {
        const a = wallets.find(w => w.asset === asset);
        if (!a) return { asset, wallet: '0', equity: '0', unrealizedPnl: '0', usedMargin: '0', available: '0' };
        // 本引擎 robots() 之外还有其它策略（如趋势引擎）在同一账户开仓，它们同样占用真实保证金。
        // 只按本引擎挂单算 usedMargin 会低估占用，甚至当 marginBalance 被其它策略拉成负数时，
        // 全局风控会把「0 > 负值×80%」判定为恒超限（实测 XRP 网格启动即被熔断）。
        // 因此 live 口径下直接以币安账户余额为准：equity 钳到 0，占用用总初始保证金按钱包权重分摊。
        const totalMargin = D(live.totalPositionInitialMargin);
        const wallet = D(a.walletBalance);
        const walletTotal = wallets.reduce((s, w) => s.plus(w.walletBalance), D(0));
        const share = walletTotal.gt(0) ? wallet.div(walletTotal) : D(0);
        const used = totalMargin.mul(share).toFixed();
        const equity = Math.max(0, Number(a.marginBalance));
        return { asset, wallet: a.walletBalance, equity: String(equity), unrealizedPnl: a.unrealizedProfit,
          usedMargin: used, available: a.availableBalance };
      });
      return accounts;
    }
    // 账户口径：优先真实账户；未启用实盘时以本地钱包为纸面基准（默认 0，不预置模拟资金）。
    return (['USDC', 'USDT'] as QuoteAsset[]).map(asset => {
      let pnl = D(0), used = D(0);
      for (const robot of this.robots.filter(r => r.symbol.endsWith(asset))) {
        const market = this.markets.find(m => m.symbol === robot.symbol);
        pnl = pnl.plus(unrealized(robot, market));
        const pending = openingNotional(this.orders, robot.id);
        used = used.plus(positionNotional(robot, market).plus(pending).div(robot.leverage))
          .plus(pending.mul(robot.makerFeeBps).div(10000));
      }
      const equity = D(this.wallets[asset]).plus(pnl);
      return { asset, wallet: this.wallets[asset], equity: equity.toFixed(), unrealizedPnl: pnl.toFixed(),
        usedMargin: used.toFixed(), available: Decimal.max(0, equity.minus(used)).toFixed() };
    });
  }

  summary(now = Date.now()): Summary {
    const accounts = this.accounts();
    const sum = (key: 'equity' | 'unrealizedPnl' | 'usedMargin') => accounts.reduce((s, a) => s.plus(a[key]), D(0)).toNumber();
    const equity = sum('equity');
    // 已实现盈亏只统计真实成交产生的净收益；无模拟初始资金基准。
    const realizedPnl = this.robots.reduce((sum, r) => sum.plus(r.realizedPnl), D(0)).toNumber();
    return {
      equity, unrealizedPnl: sum('unrealizedPnl'), usedMargin: sum('usedMargin'),
      realizedPnl, fees: Number(this.totalFees), filledNotional: Number(this.totalFilledNotional),
      grossPosition: this.robots.reduce((s, r) => s.plus(positionNotional(r, this.markets.find(m => m.symbol === r.symbol))), D(0)).toNumber(),
      reservedNotional: openingNotional(this.orders).toNumber(),
      dailyPnl: D(equity).minus(this.dailyStartEquity).toNumber(),
      drawdownPercent: D(this.peakEquity).gt(0) ? Math.max(0, D(this.peakEquity).minus(equity).div(this.peakEquity).mul(100).toNumber()) : 0,
      runningCount: this.robots.filter(r => r.status === 'running' || r.status === 'reduce_only').length,
      ordersCount: this.orders.length, actionsLastMinute: this.budget.count(now), accounts,
    };
  }

  preview(raw: unknown) {
    const config = robotSchema.parse(raw);
    const market = this.market(config.symbol);
    const account = this.accounts().find(a => a.asset === market.quoteAsset)!;
    const levels = gridLevels(config, market).map(level => {
      const quantity = orderQuantity(config, market, level.price, account);
      return { ...level, quantity, notional: D(quantity).mul(level.price).toFixed() };
    });
    const notional = levels.reduce((s, l) => s.plus(l.notional), D(0));
    return { levels, totalNotional: notional.toFixed(), estimatedMargin: notional.div(config.leverage).toFixed(),
      referencePrice: midPrice(market).toFixed(), instrument: market,
      budgetLimited: notional.gt(config.maxOpenNotional) || notional.div(2).gt(config.maxPositionNotional),
    };
  }

  addRobot(raw: unknown, now = Date.now()): Robot {
    const config = robotSchema.parse(raw);
    if (this.robots.some(r => r.symbol === config.symbol)) throw new Error('该合约已有机器人；请编辑现有策略，避免重复报价');
    if (this.robots.length >= 30) throw new Error('最多创建 30 个机器人');
    this.preview(config);
    const robot: Robot = { ...config, id: randomUUID(), createdAt: now, status: 'paused', reason: '等待启动',
      cooldownUntil: 0, centerPrice: '0', lastRecenterAt: 0, lastQuoteAt: 0,
      positionQty: '0', entryPrice: '0', realizedPnl: '0', fees: '0', filledNotional: '0', fillCount: 0 };
    this.robots.push(robot);
    this.log('info', 'robot', `创建 ${robot.name}，${robot.gridCount} 格，${robot.leverage}× 杠杆`, robot, now);
    return robot;
  }

  editRobot(id: string, raw: unknown, now = Date.now()) {
    const config = robotSchema.parse(raw), robot = this.robot(id);
    if (config.symbol !== robot.symbol) throw new Error('不能修改已有机器人的合约；请新建机器人');
    this.preview(config);
    this.cancelOrders(o => o.robotId === id, now);
    Object.assign(robot, config, { status: 'paused', reason: '参数已保存，旧挂单已撤销；复核后重新启动', centerPrice: '0', lastQuoteAt: 0 });
    this.log('info', 'robot', '已修改参数并暂停，现有持仓保留', robot, now);
    return robot;
  }

  /**
   * AI 指挥官/程序化热更参数：与 editRobot 不同，本方法不强制暂停，允许"运行中"机器人
   * 撤旧单 → 合并新参数 → 立即重新 quoteGrid。若机器人当前不是 running，则只更新参数不启动。
   * 只接受已通过 guardrail 校验的白名单字段（AI_ALLOWED_FIELDS），完整参数变更请走 editRobot。
   */
  // robotSchema 被 .strict().superRefine() 包装成 ZodEffects，不再暴露 .shape，
  // 因此这里用显式的 RobotConfig 字段清单来挑选可校验字段做合并。
  private static readonly CONFIG_FIELDS = ['name', 'symbol', 'sizingMode', 'orderSize', 'contractSize', 'gridCount', 'rangeMode', 'halfRange', 'recenterMinutes', 'repriceSeconds', 'orderTtlSeconds', 'closeOffsetMode', 'closeLongOffset', 'closeShortOffset', 'leverage', 'maxPositionNotional', 'maxOpenNotional', 'maxOrderNotional', 'stopLossQuote', 'stopLossPercent', 'shockPercent', 'cooldownSeconds', 'makerFeeBps', 'inventorySkew', 'exitTimeoutSeconds'];

  applyLiveParams(id: string, partial: Partial<RobotConfig>, now = Date.now()) {
    const robot = this.robot(id);
    // 只挑选 RobotConfig 字段做合并与校验，避免运行时字段（id/status/positionQty 等）触发 strict 拒绝。
    const candidate: Record<string, unknown> = {};
    for (const key of MakerEngine.CONFIG_FIELDS) {
      const value = (partial as unknown as Record<string, unknown>)[key] ?? (robot as unknown as Record<string, unknown>)[key];
      candidate[key] = value;
    }
    candidate.symbol = robot.symbol;
    const config = robotSchema.parse(candidate);
    this.preview(config);
    const wasRunning = robot.status === 'running';
    // 参数可能影响挂单密度/间距，先撤旧单再按新参数重挂
    this.cancelOrders(o => o.robotId === id, now);
    Object.assign(robot, config, { lastQuoteAt: 0 });
    this.log('info', 'ai', `AI 热更参数 ${robot.symbol}: ${JSON.stringify(partial)}`, robot, now);
    if (!wasRunning) {
      robot.reason = '参数已更新（AI），机器人保持暂停';
      return robot;
    }
    const market = this.markets.find(m => m.symbol === robot.symbol);
    if (this.fresh(market, now)) {
      robot.reason = 'Maker 双向挂单（AI 热更后），风控监测中';
      this.quoteGrid(robot, market, now);
    } else {
      robot.status = 'running';
      robot.reason = '行情暂不可用，AI 热更后待下一轮出价';
    }
    return robot;
  }

  deleteRobot(id: string, now = Date.now()) {
    const robot = this.robot(id);
    if (!D(robot.positionQty).isZero()) throw new Error('机器人仍有持仓，不能删除；请先只减仓并等待成交');
    this.cancelOrders(o => o.robotId === id, now);
    this.robots = this.robots.filter(r => r.id !== id);
    this.log('info', 'robot', '删除无持仓机器人', robot, now);
  }

  private fresh(market: Market | undefined, now: number): market is Market {
    return !!market && validMarket(market) && market.updatedAt <= now + 5000
      && now - market.updatedAt <= this.settings.staleAfterSeconds * 1000
      && this.feed.status === 'connected';
  }

  private shockPercent(market: Market, now: number): number {
    const recent = market.history.filter(h => now - h.time <= 10000 && h.time <= now).map(h => h.price).filter(p => Number.isFinite(p) && p > 0);
    if (recent.length < 2) return 0;
    return (Math.max(...recent) / Math.min(...recent) - 1) * 100;
  }

  private assertStart(robot: Robot, now: number, reducing = false) {
    if (this.emergencyStopped) throw new Error('全局紧急停止仍生效，请先解除停止；解除后也不会自动开仓');
    if (this.execution === 'live' && !this.liveBroker?.configured) {
      throw new Error('实盘凭据未配置，无法启动机器人；请检查 .env 中的 BINANCE_LIVE_*');
    }
    const market = this.markets.find(m => m.symbol === robot.symbol);
    if (!this.fresh(market, now)) throw new Error('行情未连接或已经过期，暂不允许挂单');
    if (robot.cooldownUntil > now) throw new Error(`熔断冷却尚余 ${Math.ceil((robot.cooldownUntil - now) / 1000)} 秒`);
    if (!reducing && this.shockPercent(market, now) >= robot.shockPercent) throw new Error('短时波动仍超限，请等待行情稳定');
    if (!reducing && D(robot.realizedPnl).plus(unrealized(robot, market)).lte(-robot.stopLossQuote)) throw new Error('机器人累计亏损已到上限，仅可只减仓或复核参数');
    if (!reducing && positionNotional(robot, market).gte(robot.maxPositionNotional)) throw new Error('当前持仓已达到上限，仅可只减仓');
  }

  startRobot(id: string, now = Date.now()) {
    this.enforceGlobal(now);
    const robot = this.robot(id);
    this.assertStart(robot, now);
    this.cancelOrders(o => o.robotId === id, now);
    robot.status = 'running'; robot.reason = 'Maker 网格已启动'; robot.centerPrice = '0'; robot.lastQuoteAt = 0;
    this.log('info', 'robot', `启动 Maker 网格（${this.execution === 'live' ? '实盘' : '纸面' }）`, robot, now);
    if (this.execution === 'live') void this.syncLiveAccount(now);
    this.quoteGrid(robot, this.market(robot.symbol), now);
  }

  pauseRobot(id: string, now = Date.now()) {
    const robot = this.robot(id);
    const count = this.cancelOrders(o => o.robotId === id, now);
    robot.status = 'paused'; robot.reason = `已撤销 ${count} 笔挂单，持仓保留`;
    this.log('info', 'robot', robot.reason, robot, now);
  }

  reduceRobot(id: string, now = Date.now()) {
    const robot = this.robot(id);
    this.assertStart(robot, now, true);
    if (D(robot.positionQty).isZero()) throw new Error('当前没有可减仓的持仓');
    this.cancelOrders(o => o.robotId === id, now);
    robot.status = 'reduce_only'; robot.reason = '仅挂 Reduce-only 限价单，等待被动成交'; robot.lastQuoteAt = 0;
    this.log('warning', 'robot', '进入只减仓；不使用市价单，成交时间无法保证', robot, now);
    this.quoteExit(robot, this.market(robot.symbol), now);
  }

  cancelOrders(predicate: (order: Order) => boolean, now: number): number {
    const removed = this.orders.filter(predicate);
    this.orders = this.orders.filter(o => !predicate(o));
    this.budget.recordCancellation(removed.length, now);
    if (this.execution === 'live' && this.liveBroker) {
      for (const order of removed) {
        const meta = this.liveOrderMeta.get(order.id);
        if (!meta) continue;
        const symbol = meta.symbol;
        this.pendingCancels.set(symbol, (this.pendingCancels.get(symbol) ?? 0) + 1);
        this.liveBroker.cancelOrder(meta.symbol, meta.orderId, meta.clientOrderId)
          .then(() => this.liveOrderMeta.delete(order.id))
          .catch(error => {
            // -2011（ORDER_REJECTED）多为"订单已被成交或被系统撤掉"的正常竞态，不刷屏
            const message = error instanceof Error ? error.message : String(error);
            const isBenign = message.includes('订单被拒') || /订单不存在|unknown order/i.test(message);
            this.log(isBenign ? 'info' : 'warning', 'order',
              isBenign ? `撤单跳过（订单已完成或已不存在）` : `实盘撤单失败：${message}`, undefined, now);
          })
          .finally(() => {
            const left = (this.pendingCancels.get(symbol) ?? 1) - 1;
            if (left > 0) this.pendingCancels.set(symbol, left); else this.pendingCancels.delete(symbol);
          });
      }
    }
    return removed.length;
  }

  /** 挂接独立成交流水。传 null 可断开（测试用）。 */
  attachTradeLog(log: TradeLogLike | null) { this.tradeLog = log; }

  /** 把成交写入流水。写入失败绝不能影响交易本身，且一分钟最多告警一次避免刷屏。 */
  private recordTrade(fill: Fill, now: number) {
    if (!this.tradeLog) return;
    try {
      const robot = this.robots.find(r => r.id === fill.robotId);
      if (robot) this.tradeLog.setRobotName(robot.id, robot.name);
      this.tradeLog.record(fill);
    } catch (error) {
      const key = 'trade-log';
      if (now - (this.lastNotice.get(key) ?? 0) >= 60000) {
        this.log('warning', 'system', `成交流水写入失败：${error instanceof Error ? error.message : error}`, undefined, now);
        this.lastNotice.set(key, now);
      }
    }
  }

  stopAll(reason = '用户触发紧急停止', now = Date.now()) {
    const count = this.cancelOrders(() => true, now);
    this.emergencyStopped = true; this.stopReason = reason;
    // 注意：默认刻意「保留持仓、不自动平仓」——熔断触发时通常已在浮亏，自动平仓可能正好卖在低点，
    // 所以交给人工复核（操作员可手动 reduce 或平仓，再解除停止）。
    // 但实测这个默认值有代价：熔断后裸仓无人管理 6.9 小时、行情 -8%、亏损从 -0.6 扩大到 -5.56 U。
    // 因此提供 settings.flattenOnStop 让运营者自行选择：开启后有持仓的机器人转入只减仓平掉。
    const flatten = this.settings.flattenOnStop === true;
    this.robots.forEach(r => {
      if (flatten && !D(r.positionQty).isZero()) {
        r.status = 'reduce_only'; r.lastQuoteAt = 0;
        r.reason = `${reason}；已撤单，转入只减仓平掉持仓`;
      } else {
        r.status = 'paused'; r.reason = `${reason}；已撤单，持仓保留，请人工复核`;
      }
    });
    this.log('critical', 'risk', `${reason}：撤销 ${count} 笔挂单，禁止新增订单；${flatten ? '有持仓的机器人转入只减仓' : '持仓未平仓'}`, undefined, now);
  }

  clearStop(now = Date.now(), rebaseline = false) {
    const summary = this.summary(now);
    const breached = summary.dailyPnl <= -this.settings.dailyLossLimit || summary.drawdownPercent >= this.settings.maxDrawdownPercent;
    if (breached && !rebaseline) {
      throw new Error('亏损或回撤仍超过风控上限；请先复核持仓和风控参数');
    }
    if (breached) {
      // 人工复核后重置基准。原实现只抛错、不提供任何重置路径，导致回撤锁一旦触发就永久卡住：
      // 实测 2026-09-15 平掉裸头寸后权益 49.38、峰值 52.21，回撤 5.4% 一直 > 5%，机器人再也启不起来。
      // 操作员点击「解除停止」是显式行为，这里把当前权益设为新基准，并留下醒目日志。
      this.peakEquity = String(summary.equity);
      this.dailyStartEquity = String(summary.equity);
      this.log('warning', 'risk',
        `人工解除停止并重置风控基准：权益 ${summary.equity.toFixed(2)} U（回撤 ${summary.drawdownPercent.toFixed(2)}%，日内 ${summary.dailyPnl.toFixed(2)} U）`,
        undefined, now);
    }
    this.emergencyStopped = false; this.stopReason = '';
    this.log('warning', 'risk', '已解除全局停止，所有机器人保持暂停，需手动启动', undefined, now);
  }

  updateRisk(raw: unknown, now = Date.now()) {
    this.settings = riskSchema.parse(raw);
    this.log('warning', 'risk', '全局风控参数已更新并立即复核', undefined, now);
    this.enforceGlobal(now);
  }

  switchSource(source: MarketSource, now = Date.now()) {
    if (source === this.source) return;
    if (this.robots.some(r => !D(r.positionQty).isZero())) throw new Error('尚有持仓，不能切换计价行情；请平仓后切换，或重置工作台数据');
    this.robots.forEach(r => this.pauseRobot(r.id, now));
    this.source = source;
    this.markets = source === 'simulation' ? sampleMarkets(now) : [];
    this.lastMatched.clear();
    this.feed = source === 'simulation'
      ? { status: 'connected', message: '本地模拟行情 · 无真实订单', updatedAt: now }
      : { status: 'connecting', message: '正在连接币安公开行情', updatedAt: 0 };
    this.log('warning', 'system', source === 'simulation' ? '已切换本地模拟行情' : '已切换币安公开行情', undefined, now);
  }

  async setExecution(mode: ExecutionMode, now = Date.now()): Promise<void> {
    if (mode === this.execution) return;
    if (this.liveSwitchInFlight) throw new Error('执行模式正在切换中，请稍候');
    this.liveSwitchInFlight = true; this.executionStatus = 'switching';
    try {
      if (mode === 'live') {
        if (!this.liveBroker) throw new Error('实盘连接器未初始化；请重启服务');
        if (!this.liveBroker.configured) throw new Error(this.liveBroker.configurationIssue ?? '实盘凭据未配置');
        await this.liveBroker.synchronizeClock();
        const account = await this.liveBroker.getAccount();
        this.liveAccount = { ...account, fetchedAt: now };
        this.liveStatus = this.liveBroker.status();
        for (const r of this.robots) this.cancelOrders(o => o.robotId === r.id, now);
        this.execution = 'live';
        this.executionMessage = `实盘已启用 · ${this.liveBroker.environment} · 钱包余额 ${account.totalWalletBalance} U`;
        this.feed = { status: 'connected', message: '币安实盘模式 · 真实账户', updatedAt: now };
        this.log('warning', 'live', `已切换到实盘：${this.liveBroker.environment}，钱包 ${account.totalWalletBalance} U`, undefined, now);
        await this.syncLiveOrders(now);
        await this.syncLiveAccount(now);
        // Re-baseline daily PnL against the live wallet so the global risk envelope does not fire on the first step.
        const liveEquity = D(account.totalWalletBalance).plus(account.totalUnrealizedProfit).toFixed();
        this.dailyStartEquity = liveEquity; this.peakEquity = liveEquity; this.day = new Date(now).toISOString().slice(0, 10);
        // 重建外部资金基线：首次 live 同步会以当前钱包为基准，避免把存量余额误判为入金。
        this.lastWalletSeen = null; this.lastRealizedSeen = null; this.lastFeesSeen = null;
        this.executionStatus = 'live';
      } else {
        for (const r of this.robots) this.cancelOrders(o => o.robotId === r.id, now);
        this.execution = 'paper';
        // Re-baseline the local paper wallet so the global envelope does not fire on the first step.
        const paperEquity = D(this.wallets.USDC).plus(this.wallets.USDT).toFixed();
        this.dailyStartEquity = paperEquity; this.peakEquity = paperEquity;
        this.executionMessage = '已切回：真实行情 + 本地纸面成交（未连接实盘）';
        this.feed = { status: 'connected', message: '币安真实行情 · 纸面成交（未连接实盘）', updatedAt: now };
        this.log('warning', 'live', '已切换到纸面运行（未连接实盘）', undefined, now);
        this.executionStatus = 'idle';
      }
    } catch (error) {
      this.executionStatus = 'error';
      this.executionMessage = error instanceof Error ? error.message : '切换执行模式失败';
      this.log('critical', 'live', `切换执行模式失败：${this.executionMessage}`, undefined, now);
      throw error;
    } finally { this.liveSwitchInFlight = false; }
  }

  async syncLiveAccount(now = Date.now()): Promise<void> {
    if (this.execution !== 'live' || !this.liveBroker) return;
    if (now - this.lastAccountSync < 5000) return;
    this.lastAccountSync = now;
    try {
      const account = await this.liveBroker.getAccount();
      this.liveAccount = { ...account, fetchedAt: now };
      this.liveStatus = this.liveBroker.status();
      // Reconcile positions for the robots we own, from BOTH hedge legs (LONG/SHORT/BOTH).
      for (const robot of this.robots) {
        const own = account.positions.filter(p => p.symbol === robot.symbol);
        let netQty = D(0), entry = '0';
        for (const pos of own) {
          netQty = netQty.plus(pos.positionAmt);
          if (D(entry).isZero() && !D(pos.entryPrice).isZero()) entry = pos.entryPrice;
        }
        if (netQty.isZero()) {
          if (!D(robot.positionQty).isZero()) {
            // 用户在币安手动平仓后引擎仍残留本地持仓，会驱动错误的只减仓逻辑；以交易所为准归零
            this.log('warning', 'live', `${robot.name}：币安实际持仓已归零，本地残留 ${robot.positionQty} 已重置（常见为在币安 App 手动平仓）`, robot, now);
            robot.positionQty = '0'; robot.entryPrice = '0';
          }
        } else {
          const qty = netQty.toFixed();
          if (!D(robot.positionQty).eq(qty)) {
            this.log('info', 'live', `${robot.name}：本地持仓 ${robot.positionQty} 与币安 ${qty} 不一致，已按币安净持仓为准`, robot, now);
          }
          robot.positionQty = qty;
          robot.entryPrice = entry === '0' ? robot.entryPrice : entry;
        }
      }
      this.executionStatus = 'live';
      this.calibrateExternalFlow(account, now);
    } catch (error) {
      this.executionStatus = 'error';
      this.executionMessage = error instanceof Error ? error.message : '同步账户失败';
      this.liveStatus = this.liveBroker.status();
      this.log('warning', 'live', `同步实盘账户失败：${this.executionMessage}`, undefined, now);
    }
  }

  /**
   * 外部资金变动校准（入金/出金剥离）。
   * 币安钱包余额变化 = 非交易资金流 + (Σ 实现盈亏 + 手续费净额)；引擎对后者有精确累计，
   * 因此「钱包增量 − (ΣrealizedPnl 增量 + fees 增量)」即为入金/出金。
   * 该部分必须从 dailyPnl/回撤基准中剔除：否则转入本金会被误记为当日盈利
   * （实测 2026-09-20 转入 40 U 后 dailyPnl 虚增 +40，掩盖真实亏损）。
   * 只在 live 模式下调用；首次同步只建立基线不判定；偏差小于阈值 1U 视为资金费率/BNB 抵扣噪声忽略。
   */
  private calibrateExternalFlow(account: { totalWalletBalance: string }, now: number) {
    const wallet = D(account.totalWalletBalance);
    let totalPnl = D(0), totalFees = D(0);
    for (const r of this.robots) totalPnl = totalPnl.plus(r.realizedPnl);
    totalFees = D(this.totalFees);
    if (this.lastWalletSeen === null) {
      // 重启后的首次同步没有「上次钱包」做增量对比。此时若 dailyStartEquity 仍是重启前基线，
      // 而钱包里已包含未剥离的非交易资金（入金/出金），dailyPnl 会持续虚高/虚低
      // （实测 2026-09-20 入金 40U，重启后 dailyPnl 恒显 +40）。把日内/回撤基准重定为当前权益，
      // 让指标从当前实际资金起算；峰值保持不动避免丢失历史回撤，靠 enforceGlobal 实时再爬升。
      const equity = wallet.plus(D(this.liveAccount?.totalUnrealizedProfit ?? '0'));
      this.dailyStartEquity = equity.toFixed();
      this.log('warning', 'live', `重启后首同步：日内基准重定为当前权益 ${equity.toFixed(2)} U（剥离非交易资金残差）`, undefined, now);
      this.lastWalletSeen = wallet; this.lastRealizedSeen = totalPnl; this.lastFeesSeen = totalFees;
      return;
    }
    const walletDelta = wallet.minus(this.lastWalletSeen);
    const explained = totalPnl.minus(this.lastRealizedSeen ?? D(0)).plus(totalFees.minus(this.lastFeesSeen ?? D(0)));
    const external = walletDelta.minus(explained);
    this.lastWalletSeen = wallet; this.lastRealizedSeen = totalPnl; this.lastFeesSeen = totalFees;
    // 阈值 1U：资金费率（每 8 小时约几厘）、BNB 抵扣手续费等都在这个量级以下。
    if (external.abs().lte(1)) return;
    // 入金/出金抬高或压低 wallet 余额，但不能算作交易盈亏，也不应计入回撤基准。
    this.dailyStartEquity = D(this.dailyStartEquity).plus(external).toFixed();
    this.peakEquity = D(this.peakEquity).plus(external).toFixed();
    this.log('warning', 'live', `检测到非交易资金变动 ${external.toFixed(2)} U（入金/出金），已从当日盈亏与回撤基准中剥离`, undefined, now);
  }

  async syncLiveOrders(now = Date.now()): Promise<void> {
    if (this.execution !== 'live' || !this.liveBroker) return;
    // 15 秒节流 + 按币种查询：全市场 openOrders 权重 40/次，1s 一次会直接打满 2400/min 触发 429/418
    if (now - this.lastOrderSync < 15000) return;
    this.lastOrderSync = now;
    try {
      const symbols = [...new Set(this.robots.map(r => r.symbol))];
      const live: FuturesOrder[] = [];
      for (const symbol of symbols) {
        if (live.length >= 300) break;
        try {
          live.push(...(await this.liveBroker.getOpenOrders(symbol)));
        } catch (error) {
          this.log('warning', 'live', `同步 ${symbol} 挂单失败：${error instanceof Error ? error.message : '未知错误'}`, undefined, now);
        }
      }
      const liveIds = new Set(live.map(o => `${o.symbol}:${o.orderId}`));
      // Drop locally tracked orders that no longer exist on the exchange.
      this.orders = this.orders.filter(o => {
        const meta = this.liveOrderMeta.get(o.id);
        return meta ? liveIds.has(`${meta.symbol}:${meta.orderId}`) : false;
      });
      // Append exchange orders we haven't seen yet; only adopt our own (clientOrderId 前缀 pm-)。
      // 人工/外部挂单只提示不接管，避免网格误撤误动用户自己的订单。
      for (const exchange of live) {
        const key = `${exchange.symbol}:${exchange.orderId}`;
        const alreadyKnown = this.orders.some(o => {
          const meta = this.liveOrderMeta.get(o.id);
          return meta && `${meta.symbol}:${meta.orderId}` === key;
        });
        if (alreadyKnown) continue;
        if (!/^pm-/.test(exchange.clientOrderId ?? '')) {
          if (now - (this.lastNotice.get(`external:${key}`) ?? 0) >= 60000) {
            this.log('warning', 'live', `检测到外部订单 ${exchange.symbol} ${exchange.side} ${exchange.origQty} @ ${exchange.price ?? '市价'}（手工挂单或其它程序），引擎不接管、不撤除`, undefined, now);
            this.lastNotice.set(`external:${key}`, now);
          }
          continue;
        }
        const robot = this.robots.find(r => r.symbol === exchange.symbol);
        if (!robot) continue;
        const localId = randomUUID();
        const clientOrderId = exchange.clientOrderId ?? `local-${localId.slice(0, 8)}`;
        this.orders.push({ id: localId, robotId: robot.id, symbol: exchange.symbol, side: exchange.side,
          price: exchange.price ?? '0', quantity: exchange.origQty, remaining: exchange.origQty,
          reduceOnly: exchange.reduceOnly ?? false, createdAt: exchange.time ?? now, timeInForce: 'GTX',
          status: 'NEW', liveOrderId: exchange.orderId, liveClientOrderId: clientOrderId, lastSyncedAt: now });
        this.liveOrderMeta.set(localId, { orderId: exchange.orderId, clientOrderId, symbol: exchange.symbol });
      }
      this.liveStatus = this.liveBroker.status();
    } catch (error) {
      this.liveStatus = this.liveBroker?.status() ?? null;
      this.log('warning', 'live', `同步实盘挂单失败：${error instanceof Error ? error.message : '未知错误'}`, undefined, now);
    }
  }

  async syncLiveTrades(now = Date.now()): Promise<void> {
    if (this.execution !== 'live' || !this.liveBroker || !this.liveAccount) return;
    if (now - this.lastTradeSync < 2000) return;
    for (const robot of this.robots) {
      try {
        const since = this.lastTradesBySymbol.get(robot.symbol) ?? (now - 24 * 60 * 60 * 1000);
        const trades = await this.liveBroker.getUserTrades(robot.symbol, since, 100);
        for (const trade of trades) this.applyLiveTrade(robot, trade, now);
        if (trades.length) this.lastTradesBySymbol.set(robot.symbol, trades.at(-1)!.time + 1);
      } catch (error) {
        this.log('warning', 'live', `同步 ${robot.symbol} 成交失败：${error instanceof Error ? error.message : '未知错误'}`, robot, now);
      }
    }
    this.lastTradeSync = now;
  }

  private applyLiveTrade(robot: Robot, trade: UserTrade, now: number) {
    const dedupe = `live-${trade.id ?? `${trade.orderId}-${trade.time}-${trade.qty}`}`;
    if (this.fills.some(f => f.id === dedupe)) return;
    const quantity = D(trade.qty), price = D(trade.price), fee = D(trade.commission);
    const result = positionAfterFill(robot.positionQty, robot.entryPrice, trade.side, trade.qty, trade.price);
    const notional = quantity.mul(price);
    // 已实现盈亏以币安返回为准，避免本地 entryPrice 被污染时算出假盈亏
    const realized = D(trade.realizedPnl).isFinite() ? D(trade.realizedPnl) : D(result.realizedPnl);
    // 持仓与开仓价只由 syncLiveAccount 以「币安绝对持仓」写入。此处若再按成交增量累加，
    // 会把 syncLiveAccount 已经计入的同一笔成交重复计算，使本地持仓系统性虚高 1-2 笔；
    // 虚高的持仓会让 positionNotional 提前越过上限，误触发只减仓。
    // （实测：本地 28 对币安 21、本地 35 对币安 21，偏差恒为 1-2 个 orderSize）
    robot.realizedPnl = D(robot.realizedPnl).plus(realized).minus(fee).toFixed();
    robot.fees = D(robot.fees).plus(fee).toFixed();
    robot.filledNotional = D(robot.filledNotional).plus(notional).toFixed(); robot.fillCount++;
    this.totalFees = D(this.totalFees).plus(fee).toFixed();
    this.totalFilledNotional = D(this.totalFilledNotional).plus(notional).toFixed();
    if (this.liveAccount) {
      this.liveAccount.totalUnrealizedProfit = D(this.liveAccount.totalUnrealizedProfit).plus(realized).toFixed();
    }
    const fill: Fill = { id: dedupe, orderId: dedupe, robotId: robot.id, symbol: robot.symbol,
      side: trade.side, price: trade.price, quantity: trade.qty, fee: fee.toFixed(),
      realizedPnl: realized.toFixed(), time: trade.time, liquidity: trade.maker ? 'MAKER' : 'TAKER',
      execution: 'LIVE', tradeId: trade.id !== undefined ? String(trade.id) : undefined };
    this.fills.unshift(fill);
    this.fills = this.fills.slice(0, 2000);
    this.recordTrade(fill, now);
    this.log('info', 'order', `实盘 ${trade.side === 'BUY' ? '买入' : '卖出'} ${trade.qty} ${robot.symbol} @ ${trade.price}，手续费 ${trade.commission} ${trade.commissionAsset}`, robot, now);
  }

  acceptMarkets(markets: Market[], now = Date.now()) {
    const updated = new Set(markets.map(m => m.symbol));
    this.markets = [...markets, ...this.markets.filter(m => !updated.has(m.symbol) && this.robots.some(r => r.symbol === m.symbol))];
    this.feed = { status: 'connected', message: this.source === 'simulation' ? '本地模拟行情 · 无真实订单' : '币安公开行情', updatedAt: now };
  }

  private matchRestingOrders(market: Market, now: number) {
    if (this.execution === 'live') return; // Live fills come from the trade sync path.
    if (!this.fresh(market, now) || market.updatedAt <= (this.lastMatched.get(market.symbol) ?? 0)) return;
    this.lastMatched.set(market.symbol, market.updatedAt);
    const liquidity = { BUY: floorStep(D(market.askQty).mul(0.1), market.quantityStep), SELL: floorStep(D(market.bidQty).mul(0.1), market.quantityStep) };
    const candidates = this.orders.filter(o => o.symbol === market.symbol && o.createdAt < market.updatedAt)
      .sort((a, b) => a.side === b.side ? (a.side === 'BUY' ? D(b.price).cmp(a.price) : D(a.price).cmp(b.price)) || a.createdAt - b.createdAt : a.side.localeCompare(b.side));
    for (const order of candidates) {
      const crossed = order.side === 'BUY' ? D(market.ask).lt(order.price) : D(market.bid).gt(order.price);
      if (!crossed || liquidity[order.side].lte(0)) continue;
      const robot = this.robot(order.robotId);
      let quantity = Decimal.min(D(order.remaining), liquidity[order.side]);
      if (order.reduceOnly) {
        const canReduce = (order.side === 'SELL' && D(robot.positionQty).gt(0)) || (order.side === 'BUY' && D(robot.positionQty).lt(0));
        quantity = canReduce ? Decimal.min(quantity, D(robot.positionQty).abs()) : D(0);
      }
      quantity = floorStep(quantity, market.quantityStep);
      if (quantity.lte(0)) {
        if (order.reduceOnly) this.cancelOrders(o => o.id === order.id, now);
        continue;
      }
      const result = positionAfterFill(robot.positionQty, robot.entryPrice, order.side, quantity.toFixed(), order.price);
      const notional = quantity.mul(order.price), fee = notional.mul(robot.makerFeeBps).div(10000);
      const netPnl = D(result.realizedPnl).minus(fee);
      robot.positionQty = result.positionQty; robot.entryPrice = result.entryPrice;
      robot.realizedPnl = D(robot.realizedPnl).plus(netPnl).toFixed();
      robot.fees = D(robot.fees).plus(fee).toFixed();
      robot.filledNotional = D(robot.filledNotional).plus(notional).toFixed(); robot.fillCount++;
      this.wallets[market.quoteAsset] = D(this.wallets[market.quoteAsset]).plus(netPnl).toFixed();
      this.totalFees = D(this.totalFees).plus(fee).toFixed();
      this.totalFilledNotional = D(this.totalFilledNotional).plus(notional).toFixed();
      order.remaining = D(order.remaining).minus(quantity).toFixed();
      order.status = 'PARTIALLY_FILLED';
      liquidity[order.side] = liquidity[order.side].minus(quantity);
      const fill: Fill = { id: randomUUID(), orderId: order.id, robotId: robot.id, symbol: robot.symbol,
        side: order.side, price: order.price, quantity: quantity.toFixed(), fee: fee.toFixed(),
        realizedPnl: netPnl.toFixed(), time: now, liquidity: 'MAKER', execution: 'SIMULATED' };
      this.fills.unshift(fill);
      this.recordTrade(fill, now);
      this.log('info', 'order', `纸面 ${order.side === 'BUY' ? '买入' : '卖出'} ${quantity.toFixed()} ${market.baseAsset} @ ${order.price}${order.reduceOnly ? ' · 只减仓' : ''}`, robot, now);
    }
    this.orders = this.orders.filter(o => D(o.remaining).gt(0));
    this.fills = this.fills.slice(0, 2000);
  }

  private cooldown(robot: Robot, reason: string, now: number) {
    if (robot.status === 'cooldown' && robot.reason === reason) return;
    const count = this.cancelOrders(o => o.robotId === robot.id, now);
    robot.status = 'cooldown'; robot.reason = reason; robot.cooldownUntil = now + robot.cooldownSeconds * 1000;
    this.log('critical', 'risk', `${reason}；撤销 ${count} 笔挂单，冷却后需手动恢复，持仓保留`, robot, now);
  }

  private enforceGlobal(now: number) {
    let summary = this.summary(now);
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day; this.dailyStartEquity = String(summary.equity);
      this.log('info', 'system', 'UTC 自然日切换，已更新日内亏损基准；停止锁不会自动解除', undefined, now);
      summary = this.summary(now);
    }
    if (summary.equity > Number(this.peakEquity)) this.peakEquity = String(summary.equity);
    if (this.emergencyStopped) return;
    if (summary.dailyPnl <= -this.settings.dailyLossLimit) { this.stopAll('日内亏损达到全局上限', now); return; }
    if (summary.drawdownPercent >= this.settings.maxDrawdownPercent) { this.stopAll('账户回撤达到全局上限', now); return; }
    const marginBreach = summary.accounts.some(a => D(a.usedMargin).gt(D(a.equity).mul(this.settings.maxMarginPercent).div(100)));
    if (summary.grossPosition + summary.reservedNotional > this.settings.maxGrossNotional || marginBreach) {
      this.cancelOrders(o => !o.reduceOnly, now);
      for (const robot of this.robots) {
        if (robot.status !== 'running') continue;
        robot.status = D(robot.positionQty).isZero() ? 'paused' : 'reduce_only';
        robot.reason = '全局敞口或保证金占用超限，停止新增仓位'; robot.lastQuoteAt = 0;
        this.log('critical', 'risk', robot.reason, robot, now);
      }
    }
  }

  step(now = Date.now()) {
    if (this.execution === 'live') {
      if (this.liveStatus?.blockedUntil && now < this.liveStatus.blockedUntil) return;
      void this.syncLiveAccount(now);
      void this.syncLiveOrders(now);
      void this.syncLiveTrades(now);
    } else {
      if (!this.emergencyStopped) {
        for (const market of this.markets) this.matchRestingOrders(market, now);
      }
    }
    for (const robot of this.robots) {
      const expired = this.cancelOrders(o => o.robotId === robot.id && now - o.createdAt >= robot.orderTtlSeconds * 1000, now);
      if (expired) this.log('info', 'order', `挂单到期，撤销 ${expired} 笔未成交剩余量`, robot, now);
    }
    this.enforceGlobal(now);
    // 停机时不再开新网格，但仍要允许只减仓把已有持仓平掉——否则每次熔断都留下裸头寸等人工处理。
    for (const robot of this.robots) {
      const market = this.markets.find(m => m.symbol === robot.symbol);
      const exposed = !D(robot.positionQty).isZero();
      if (!this.fresh(market, now)) {
        if (robot.status === 'running' || robot.status === 'reduce_only' || exposed) this.cooldown(robot, '行情断流、过期或盘口无效', now);
        continue;
      }
      if (robot.status === 'paused') continue;
      if (robot.status === 'cooldown') {
        // 冷却结束后自动恢复。能走到这里说明行情已是新鲜的（上方 654 行的过期检查已过滤）。
        // 原先这里是 `continue`，cooldown 只能靠人工 startRobot 解除：一次持续十几秒的网络抖动
        // 就会撤掉全部挂单并让机器人整夜停摆，且握着裸仓位不挂任何保护单
        // （实测 2026-09-14 03:57 与 05:00 两次，累计停摆数十分钟以上）。
        // 亏损止损走的是 paused 分支，不受此处影响，仍然需要人工复核。
        if (robot.cooldownUntil > now) continue;
        robot.status = 'running'; robot.reason = '冷却结束、行情恢复，自动重新报价';
        robot.lastQuoteAt = 0; robot.centerPrice = '0';
        this.log('warning', 'risk', robot.reason, robot, now);
      }
      const shock = this.shockPercent(market, now);
      if (shock >= robot.shockPercent) { this.cooldown(robot, '10 秒行情波动达到熔断阈值', now); continue; }
      if (D(market.markPrice).minus(midPrice(market)).abs().div(midPrice(market)).mul(100).gte(robot.shockPercent)) {
        this.cooldown(robot, '标记价格与盘口偏离超限', now); continue; }
      const loss = D(robot.realizedPnl).plus(unrealized(robot, market));
      // 两套止损各管一件事：
      //   stopLossQuote（绝对额） -> 整个会话的累计亏损，防止持续失血
      //   stopLossPercent（比例） -> 当前持仓的浮动亏损，防止单边行情里仓位越滚越亏
      // 之前只有绝对额，配上 80 USDC 的仓位上限需要行情走 19%~75% 才触发，实测一整天 0 次。
      const openLoss = unrealized(robot, market);
      const openHit = this.openStopHit(robot, market, openLoss);
      const totalHit = loss.lte(D(robot.stopLossQuote).neg());
      const lossHit = openHit || totalHit;
      if (robot.status === 'running' && (lossHit || positionNotional(robot, market).gte(D(robot.maxPositionNotional).mul(0.8)))) {
        this.cancelOrders(o => o.robotId === robot.id, now);
        robot.status = exposed ? 'reduce_only' : 'cooldown';
        robot.reason = lossHit
          ? (openHit
            ? `持仓浮亏达到上限（阈值 ${positionNotional(robot, market).mul(robot.stopLossPercent).div(100).toFixed(4)} U，持仓 ${positionNotional(robot, market).toFixed(2)} U），仅允许减仓`
            : `累计亏损达到上限（阈值 ${robot.stopLossQuote} U），仅允许减仓`)
          : '仓位达到上限的 80%，进入只减仓';
        robot.lastQuoteAt = 0;
        if (!exposed) robot.cooldownUntil = now + robot.cooldownSeconds * 1000;
        this.log('critical', 'risk', robot.reason, robot, now);
      }
      // 残余仓位小到挂不出 Maker 单（金额 < minNotional）时，只减仓永远无法归零 → 会永久死锁：
      // 机器人既不挂单也不恢复，裸着仓位停在那里（实测 2026-09-14 09:51 卡在 2.4 XRP ≈ 3.36 USDC）。
      // 这里把机器人放回网格模式。残余仓位仍然保留——不引入市价单，维持「只做 Maker、无 MARKET 入口」
      // 的设计；但机器人不再卡死。残余量级受 minNotional/price 约束，且每轮只减仓都会重新收敛到该量级，
      // 不会逐轮累积。
      if (robot.status === 'reduce_only' && this.exitUnreachable(robot, market)) {
        robot.status = 'running'; robot.reason = '残余仓位低于最小挂单规则，保留残余并回到网格';
        robot.lastQuoteAt = 0; robot.centerPrice = '0';
        this.log('warning', 'risk', robot.reason, robot, now);
      }
      if (robot.status === 'running') { if (!this.emergencyStopped) this.quoteGrid(robot, market, now); }
      else if (robot.status === 'reduce_only') this.quoteExit(robot, market, now);
    }
  }

  /**
   * 库存偏斜：按当前持仓算出中心价应偏移多少个网格步长。
   * 多头（持仓为正）返回正数，配合 `centerPrice.minus(step × skewSteps)` 让中心价下移，
   * 于是卖单更贴近盘口、买单更远 —— 网格倾向减仓，自己往零库存回归。空头反之。
   *
   * 返回整数步长而非连续值：持仓每笔都在变，连续值会让网格每笔成交就重挂一次。
   */
  private inventorySkewSteps(robot: Robot, market: Market, perSide: number): number {
    const skew = Number(robot.inventorySkew ?? 0);
    if (!(skew > 0) || perSide <= 0) return 0;
    const qty = D(robot.positionQty);
    if (qty.isZero()) return 0;
    const cap = D(robot.maxPositionNotional);
    if (!cap.gt(0)) return 0;
    const ratio = Decimal.min(1, positionNotional(robot, market).div(cap)).toNumber();
    return Math.round((qty.gt(0) ? 1 : -1) * ratio * skew * perSide);
  }

  private quoteGrid(robot: Robot, market: Market, now: number) {
    if (now - robot.lastQuoteAt < robot.repriceSeconds * 1000) return;
    const mid = midPrice(market), center = D(robot.centerPrice);
    const half = robot.rangeMode === 'fixed' ? D(robot.halfRange) : center.mul(robot.halfRange).div(10000);
    // 库存偏斜。网格原本永远以中心价对称挂单、完全不看持仓，于是价格单向运动时会持续累积
    // 逆势仓位，最后被迫在不利价位平掉——实测平仓环节 -3.38 bps，吃掉做市收益的 82%。
    // 这里按当前持仓把中心价往「减仓方向」偏移，让网格自己往零库存回归。
    // 偏移按整个网格步长取整，避免持仓微动就重挂全部订单。
    const perSide = robot.gridCount / 2;
    const step = perSide > 0 ? half.div(perSide) : D(0);
    const skewSteps = this.inventorySkewSteps(robot, market, perSide);
    const skewMoved = skewSteps !== (this.lastSkew.get(robot.id) ?? 0);
    const recenter = center.isZero() || mid.minus(center).abs().gte(half)
      || now - robot.lastRecenterAt >= robot.recenterMinutes * 60000 || skewMoved;
    const old = this.orders.filter(o => o.robotId === robot.id);
    if (recenter && old.length) {
      if (this.budget.count(now) + old.length + 1 > this.settings.maxActionsPerMinute) {
        this.notice(`${robot.id}:budget`, '撤改单达到频率上限，暂缓普通重报；风险撤单不受阻塞', robot, now); return;
      }
      this.cancelOrders(o => o.robotId === robot.id, now);
    }
    if (recenter) {
      robot.centerPrice = mid.toFixed(); robot.lastRecenterAt = now;
      this.lastSkew.set(robot.id, skewSteps);
      if (!center.isZero()) this.log('info', 'order', `移动网格中心至 ${mid.toFixed()}，原挂单先撤后重挂`, robot, now);
    }
    this.cancelOrders(o => o.robotId === robot.id && now - o.createdAt >= robot.orderTtlSeconds * 1000, now);
    // 撤单还没在币安落地就挂新单会自成交（-5022）。跳过本轮，下一秒重试；撤单通常 <1s 完成。
    if ((this.pendingCancels.get(robot.symbol) ?? 0) > 0) return;
    const account = this.accounts().find(a => a.asset === market.quoteAsset)!;
    let added = 0, constrained = false;
    try {
      const effectiveCenter = D(robot.centerPrice).minus(step.mul(skewSteps)).toFixed();
      for (const level of gridLevels(robot, market, effectiveCenter)) {
        if (this.orders.some(o => o.robotId === robot.id && o.side === level.side && o.price === level.price)) continue;
        const quantity = orderQuantity(robot, market, level.price, account), notional = D(quantity).mul(level.price);
        const summary = this.summary(now), currentAccount = summary.accounts.find(a => a.asset === market.quoteAsset)!;
        const requiredMargin = notional.div(robot.leverage), feeReserve = notional.mul(robot.makerFeeBps).div(10000);
        const blocked = openingNotional(this.orders, robot.id).plus(notional).gt(robot.maxOpenNotional)
          || worstPosition(robot, this.orders, level.side, quantity, market.markPrice).gt(robot.maxPositionNotional)
          || D(summary.grossPosition).plus(summary.reservedNotional).plus(notional).gt(this.settings.maxGrossNotional)
          || D(currentAccount.usedMargin).plus(requiredMargin).plus(feeReserve).gt(D(currentAccount.equity).mul(this.settings.maxMarginPercent).div(100))
          || requiredMargin.plus(feeReserve).gt(currentAccount.available);
        if (blocked) { constrained = true; continue; }
        if (!this.budget.take(1, now, this.settings.maxActionsPerMinute)) { constrained = true; break; }
        if (this.execution === 'live' && this.liveBroker) {
          this.placeLiveOrder(robot, level.side, level.price, quantity, false, now).catch(error => {
            this.log('warning', 'order', `实盘挂单失败：${error instanceof Error ? error.message : error}`, robot, now);
          });
        } else {
          this.orders.push({ id: randomUUID(), robotId: robot.id, symbol: robot.symbol, ...level, quantity, remaining: quantity,
            reduceOnly: false, createdAt: now, timeInForce: 'GTX', status: 'NEW' });
        }
        added++;
      }
      robot.reason = constrained ? '部分网格受资金、仓位或频率预算限制' : 'Maker 双向挂单，风控监测中';
      if (constrained) this.notice(`${robot.id}:constrained`, robot.reason, robot, now);
      if (added) this.log('info', 'order', `新增 ${added} 笔${this.execution === 'live' ? '实盘' : ''} GTX 挂单；当前 ${this.orders.filter(o => o.robotId === robot.id).length} 笔`, robot, now);
    } catch (error) {
      this.cooldown(robot, error instanceof Error ? error.message : '报价验证失败', now);
    }
    robot.lastQuoteAt = now;
  }

  /**
   * 当前持仓的浮动亏损是否超过「持仓名义额 × stopLossPercent%」。空仓返回 false。
   *
   * 注意这里只比「浮动亏损」，不能比「累计亏损」——累计值会随时间越滚越大，而比例阈值随
   * 当前持仓变小，两者混用会导致仓位一小就立刻命中（实测：会话累计已实现 -3 U、持仓 14 U 时
   * 阈值只有 0.43 U，机器人一启动就止损）。
   * 累计失血应该由绝对阈值 stopLossQuote 去管。
   */
  private openStopHit(robot: Robot, market: Market, openLoss: Decimal): boolean {
    const percent = D(robot.stopLossPercent ?? 0);
    const notional = positionNotional(robot, market);
    if (!percent.gt(0) || !notional.gt(0)) return false;
    return openLoss.lte(notional.mul(percent).div(100).neg());
  }

  /** 残余仓位是否小到无法作为 Maker 单挂出——即 quoteExit 永远平不掉、会卡住的状态。 */
  private exitUnreachable(robot: Robot, market: Market): boolean {
    const qty = D(robot.positionQty).abs();
    if (qty.isZero()) return false;
    const price = D(market.markPrice);
    if (!price.gt(0)) return false;
    const quantity = floorStep(Decimal.min(qty, D(market.maxQty), D(robot.maxOrderNotional).div(price)), market.quantityStep);
    return quantity.lt(market.minQty) || quantity.mul(price).lt(market.minNotional);
  }

  private quoteExit(robot: Robot, market: Market, now: number) {
    if (D(robot.positionQty).isZero()) {
      this.cancelOrders(o => o.robotId === robot.id, now);
      this.reduceSince.delete(robot.id);
      if (this.emergencyStopped) {
        // 全局停机期间的减仓：平完就停住，不能自动回到网格
        robot.status = 'paused'; robot.reason = '停机减仓完成，持仓已清空；请人工复核后手动启动';
        this.log('warning', 'robot', robot.reason, robot, now);
      } else if (robot.reason.includes('亏损')) {
        // 因止损触发的减仓，归零后保持暂停，等人工确认，避免立刻再开仓亏损
        robot.status = 'paused'; robot.reason = '止损减仓完成，持仓已清空；请人工复核后手动启动';
        this.log('warning', 'robot', robot.reason, robot, now);
      } else {
        // 正常减仓（含仓位上限触发的减仓）归零后自动恢复网格，持续刷量
        robot.status = 'running'; robot.reason = '持仓已减至零，自动恢复网格刷量';
        robot.centerPrice = '0'; robot.lastQuoteAt = 0;
        this.log('info', 'robot', robot.reason, robot, now);
      }
      return;
    }
    if (now - robot.lastQuoteAt < robot.repriceSeconds * 1000) return;
    // 只减仓超时升级。Maker 减仓单在单边行情里可能长期无法成交：卖单必须挂在卖一或更高，
    // 价格一路下跌时它就一直追在盘口上方，而每轮撤单重挂还会不断丢失排队位置
    // ——实测 8 分钟 0 成交，最终裸仓无人管理 6.9 小时、亏损从 -0.6 扩大到 -5.56 U。
    // 超过 exitTimeoutSeconds 仍未平掉就改为跨价挂单（卖挂买一 / 买挂卖一），立即成交。
    // 这会付一次 taker 手续费，但换来「一定跑得掉」——平不掉的仓位比手续费贵得多。
    let reduceSince = this.reduceSince.get(robot.id);
    if (reduceSince === undefined) { reduceSince = now; this.reduceSince.set(robot.id, reduceSince); }
    const urgent = robot.exitTimeoutSeconds > 0 && now - reduceSince >= robot.exitTimeoutSeconds * 1000;
    const side = D(robot.positionQty).gt(0) ? 'SELL' as const : 'BUY' as const;
    const offsetValue = side === 'SELL' ? robot.closeLongOffset : robot.closeShortOffset;
    const offset = robot.closeOffsetMode === 'fixed' ? D(offsetValue) : midPrice(market).mul(offsetValue).div(10000);
    const target = side === 'SELL' ? midPrice(market).plus(offset) : midPrice(market).minus(offset);
    const price = urgent
      ? (side === 'SELL' ? D(market.bid).toFixed() : D(market.ask).toFixed())
      : makerPrice(side, target, market);
    const quantity = floorStep(Decimal.min(D(robot.positionQty).abs(), D(market.maxQty), D(robot.maxOrderNotional).div(price)), market.quantityStep);
    if (quantity.lt(market.minQty) || quantity.mul(price).lt(market.minNotional)) {
      this.cancelOrders(o => o.robotId === robot.id, now);
      robot.reason = '剩余仓位低于最小挂单规则，无法保证 Maker 减仓；需人工复核';
      this.notice(`${robot.id}:dust`, robot.reason, robot, now); robot.lastQuoteAt = now; return;
    }
    const existing = this.orders.filter(o => o.robotId === robot.id);
    if (existing.length === 1 && existing[0].reduceOnly && existing[0].price === price && D(existing[0].remaining).lte(quantity)
      && now - existing[0].createdAt < robot.orderTtlSeconds * 1000) return;
    if (this.budget.count(now) + existing.length + 1 > this.settings.maxActionsPerMinute) {
      this.notice(`${robot.id}:exit-budget`, '只减仓重报等待频率预算，原有减仓单保留', robot, now); return;
    }
    this.cancelOrders(o => o.robotId === robot.id, now);
    // 同上：撤单未落地前挂减仓单会与旧单自成交（-5022）
    if ((this.pendingCancels.get(robot.symbol) ?? 0) > 0) return;
    this.budget.take(1, now, this.settings.maxActionsPerMinute);
    if (this.execution === 'live' && this.liveBroker) {
      this.placeLiveOrder(robot, side, price, quantity.toFixed(), true, now, !urgent).catch(error => {
        this.log('warning', 'order', `实盘减仓挂单失败：${error instanceof Error ? error.message : error}`, robot, now);
      });
    } else {
      this.orders.push({ id: randomUUID(), robotId: robot.id, symbol: robot.symbol, side, price,
        quantity: quantity.toFixed(), remaining: quantity.toFixed(), reduceOnly: true, createdAt: now,
        timeInForce: urgent ? 'GTC' : 'GTX', status: 'NEW' });
    }
    robot.lastQuoteAt = now;
    if (urgent) this.log('warning', 'order', `只减仓超时 ${robot.exitTimeoutSeconds}s 未平掉，改为跨价成交 @ ${price}`, robot, now);
    this.log('info', 'order', `只减仓 Maker ${side === 'SELL' ? '卖单' : '买单'} ${quantity.toFixed()} @ ${price}，等待成交`, robot, now);
  }

  private async placeLiveOrder(robot: Robot, side: 'BUY' | 'SELL', price: string, quantity: string, reduceOnly: boolean, now: number, postOnly = true): Promise<FuturesOrder> {
    if (!this.liveBroker) throw new Error('实盘连接器未初始化');
    const clientOrderId = `pm-${robot.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    // 单向持仓模式(BOTH)：一个合约只有一条腿，方向完全由 side 决定，reduceOnly 可直接用于只减仓。
    // 单向模式下不能传 positionSide，传了币安会拒单。
    // 本引擎的 positionQty / entryPrice / positionAfterFill 都是「单一净持仓」模型，
    // 与单向模式一一对应；跑在对冲模式下会出现净额趋零但总敞口膨胀、止损误判等问题。
    const order = await this.liveBroker.placeLimitOrder({ symbol: robot.symbol, side, quantity, price,
      postOnly, reduceOnly, clientOrderId, workingType: 'CONTRACT_PRICE' });
    const localId = randomUUID();
    this.orders.push({ id: localId, robotId: robot.id, symbol: robot.symbol, side, price,
      quantity, remaining: order.origQty, reduceOnly, createdAt: now, timeInForce: 'GTX',
      status: order.status === 'NEW' ? 'NEW' : 'PARTIALLY_FILLED', liveOrderId: order.orderId,
      liveClientOrderId: clientOrderId, lastSyncedAt: now });
    this.liveOrderMeta.set(localId, { orderId: order.orderId, clientOrderId, symbol: robot.symbol });
    return order;
  }

  snapshot(now = Date.now()): AppState {
    let feed = { ...this.feed };
    if (feed.status === 'connected' && now - feed.updatedAt > this.settings.staleAfterSeconds * 1000) {
      feed = { ...feed, status: 'stale', message: '行情更新超时；已停止相关报价' };
    }
    return { version: 1, now, execution: this.execution, executionStatus: this.executionStatus,
      executionMessage: this.executionMessage, source: this.source, feed,
      markets: this.markets, robots: this.robots, orders: this.orders, fills: this.fills.slice(0, 200),
      events: this.events.slice(0, 200), settings: this.settings, emergencyStopped: this.emergencyStopped,
      stopReason: this.stopReason, summary: this.summary(now), liveAccount: this.liveAccount, liveStatus: this.liveStatus };
  }

  persist(): PersistedState {
    return { version: 1, execution: this.execution, source: this.source, wallets: this.wallets, markets: this.markets,
      robots: this.robots, fills: this.fills, events: this.events, settings: this.settings,
      emergencyStopped: this.emergencyStopped, stopReason: this.stopReason, day: this.day,
      dailyStartEquity: this.dailyStartEquity, peakEquity: this.peakEquity, totalFees: this.totalFees,
      totalFilledNotional: this.totalFilledNotional, liveAccount: this.liveAccount, liveStatus: this.liveStatus };
  }
}
