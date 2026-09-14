import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { defaultConfig, defaultRisk, riskSchema, robotSchema } from '../shared/config';
import type { AppState, AuditEvent, ExecutionMode, Fill, LiveAccount, LiveStatus, Market, MarketSource, Order, QuoteAccount, QuoteAsset, RiskSettings, Robot, RobotConfig, Summary } from '../shared/types';
import { D, floorStep, gridLevels, makerPrice, midPrice, openingNotional, orderQuantity, positionAfterFill, positionNotional, unrealized, validMarket, worstPosition } from './math';
import { sampleMarkets } from './markets';
import { ActionBudget } from './rate-limit';
import type { BinanceTradingClient, FuturesOrder, UserTrade } from './binance-trading';

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
  // Cached live exchange identifiers so we can cancel our orders later.
  private liveOrderMeta = new Map<string, { orderId: string; clientOrderId: string; symbol: string }>();
  private liveBroker: LiveBroker | null = null;
  private liveSwitchInFlight = false;
  private lastTradesBySymbol = new Map<string, number>();

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
      const wallets = this.liveAccount.assets.filter(a => ['USDT', 'USDC'].includes(a.asset));
      const accounts: QuoteAccount[] = (['USDC', 'USDT'] as QuoteAsset[]).map(asset => {
        const a = wallets.find(w => w.asset === asset);
        if (!a) return { asset, wallet: '0', equity: '0', unrealizedPnl: '0', usedMargin: '0', available: '0' };
        const used = this.robots.filter(r => r.symbol.endsWith(asset))
          .reduce((sum, r) => {
            const market = this.markets.find(m => m.symbol === r.symbol);
            return sum.plus(positionNotional(r, market).div(r.leverage));
          }, D(0));
        return { asset, wallet: a.walletBalance, equity: a.marginBalance, unrealizedPnl: a.unrealizedProfit,
          usedMargin: used.toFixed(), available: a.availableBalance };
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
        this.liveBroker.cancelOrder(meta.symbol, meta.orderId, meta.clientOrderId)
          .then(() => this.liveOrderMeta.delete(order.id))
          .catch(error => {
            // -2011（ORDER_REJECTED）多为"订单已被成交或被系统撤掉"的正常竞态，不刷屏
            const message = error instanceof Error ? error.message : String(error);
            const isBenign = message.includes('订单被拒') || /订单不存在|unknown order/i.test(message);
            this.log(isBenign ? 'info' : 'warning', 'order',
              isBenign ? `撤单跳过（订单已完成或已不存在）` : `实盘撤单失败：${message}`, undefined, now);
          });
      }
    }
    return removed.length;
  }

  stopAll(reason = '用户触发紧急停止', now = Date.now()) {
    const count = this.cancelOrders(() => true, now);
    this.emergencyStopped = true; this.stopReason = reason;
    this.robots.forEach(r => { r.status = 'paused'; r.reason = `${reason}；已撤单，持仓保留`; });
    this.log('critical', 'risk', `${reason}：撤销 ${count} 笔挂单，禁止新增订单；持仓未平仓`, undefined, now);
  }

  clearStop(now = Date.now()) {
    const summary = this.summary(now);
    if (summary.dailyPnl <= -this.settings.dailyLossLimit || summary.drawdownPercent >= this.settings.maxDrawdownPercent) {
      throw new Error('亏损或回撤仍超过风控上限；请先复核持仓和风控参数');
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
    } catch (error) {
      this.executionStatus = 'error';
      this.executionMessage = error instanceof Error ? error.message : '同步账户失败';
      this.liveStatus = this.liveBroker.status();
      this.log('warning', 'live', `同步实盘账户失败：${this.executionMessage}`, undefined, now);
    }
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
    robot.positionQty = result.positionQty; robot.entryPrice = result.entryPrice;
    robot.realizedPnl = D(robot.realizedPnl).plus(realized).minus(fee).toFixed();
    robot.fees = D(robot.fees).plus(fee).toFixed();
    robot.filledNotional = D(robot.filledNotional).plus(notional).toFixed(); robot.fillCount++;
    this.totalFees = D(this.totalFees).plus(fee).toFixed();
    this.totalFilledNotional = D(this.totalFilledNotional).plus(notional).toFixed();
    if (this.liveAccount) {
      this.liveAccount.totalUnrealizedProfit = D(this.liveAccount.totalUnrealizedProfit).plus(realized).toFixed();
    }
    this.fills.unshift({ id: dedupe, orderId: dedupe, robotId: robot.id, symbol: robot.symbol,
      side: trade.side, price: trade.price, quantity: trade.qty, fee: fee.toFixed(),
      realizedPnl: realized.toFixed(), time: trade.time, liquidity: trade.maker ? 'MAKER' : 'TAKER',
      execution: 'LIVE', tradeId: trade.id !== undefined ? String(trade.id) : undefined });
    this.fills = this.fills.slice(0, 2000);
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
      this.fills.unshift({ id: randomUUID(), orderId: order.id, robotId: robot.id, symbol: robot.symbol,
        side: order.side, price: order.price, quantity: quantity.toFixed(), fee: fee.toFixed(),
        realizedPnl: netPnl.toFixed(), time: now, liquidity: 'MAKER', execution: 'SIMULATED' });
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
    if (this.emergencyStopped) return;
    for (const robot of this.robots) {
      const market = this.markets.find(m => m.symbol === robot.symbol);
      const exposed = !D(robot.positionQty).isZero();
      if (!this.fresh(market, now)) {
        if (robot.status === 'running' || robot.status === 'reduce_only' || exposed) this.cooldown(robot, '行情断流、过期或盘口无效', now);
        continue;
      }
      if (robot.status === 'paused' || robot.status === 'cooldown') continue;
      const shock = this.shockPercent(market, now);
      if (shock >= robot.shockPercent) { this.cooldown(robot, '10 秒行情波动达到熔断阈值', now); continue; }
      if (D(market.markPrice).minus(midPrice(market)).abs().div(midPrice(market)).mul(100).gte(robot.shockPercent)) {
        this.cooldown(robot, '标记价格与盘口偏离超限', now); continue; }
      const loss = D(robot.realizedPnl).plus(unrealized(robot, market));
      if (robot.status === 'running' && (loss.lte(-robot.stopLossQuote) || positionNotional(robot, market).gte(D(robot.maxPositionNotional).mul(0.8)))) {
        this.cancelOrders(o => o.robotId === robot.id, now);
        robot.status = exposed ? 'reduce_only' : 'cooldown';
        robot.reason = loss.lte(-robot.stopLossQuote) ? '机器人亏损达到上限，仅允许减仓' : '仓位达到上限的 80%，进入只减仓';
        robot.lastQuoteAt = 0;
        if (!exposed) robot.cooldownUntil = now + robot.cooldownSeconds * 1000;
        this.log('critical', 'risk', robot.reason, robot, now);
      }
      if (robot.status === 'running') this.quoteGrid(robot, market, now);
      else if (robot.status === 'reduce_only') this.quoteExit(robot, market, now);
    }
  }

  private quoteGrid(robot: Robot, market: Market, now: number) {
    if (now - robot.lastQuoteAt < robot.repriceSeconds * 1000) return;
    const mid = midPrice(market), center = D(robot.centerPrice);
    const half = robot.rangeMode === 'fixed' ? D(robot.halfRange) : center.mul(robot.halfRange).div(10000);
    const recenter = center.isZero() || mid.minus(center).abs().gte(half) || now - robot.lastRecenterAt >= robot.recenterMinutes * 60000;
    const old = this.orders.filter(o => o.robotId === robot.id);
    if (recenter && old.length) {
      if (this.budget.count(now) + old.length + 1 > this.settings.maxActionsPerMinute) {
        this.notice(`${robot.id}:budget`, '撤改单达到频率上限，暂缓普通重报；风险撤单不受阻塞', robot, now); return;
      }
      this.cancelOrders(o => o.robotId === robot.id, now);
    }
    if (recenter) {
      robot.centerPrice = mid.toFixed(); robot.lastRecenterAt = now;
      if (!center.isZero()) this.log('info', 'order', `移动网格中心至 ${mid.toFixed()}，原挂单先撤后重挂`, robot, now);
    }
    this.cancelOrders(o => o.robotId === robot.id && now - o.createdAt >= robot.orderTtlSeconds * 1000, now);
    const account = this.accounts().find(a => a.asset === market.quoteAsset)!;
    let added = 0, constrained = false;
    try {
      for (const level of gridLevels(robot, market, robot.centerPrice)) {
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

  private quoteExit(robot: Robot, market: Market, now: number) {
    if (D(robot.positionQty).isZero()) {
      this.cancelOrders(o => o.robotId === robot.id, now);
      if (robot.reason.includes('亏损')) {
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
    const side = D(robot.positionQty).gt(0) ? 'SELL' as const : 'BUY' as const;
    const offsetValue = side === 'SELL' ? robot.closeLongOffset : robot.closeShortOffset;
    const offset = robot.closeOffsetMode === 'fixed' ? D(offsetValue) : midPrice(market).mul(offsetValue).div(10000);
    const target = side === 'SELL' ? midPrice(market).plus(offset) : midPrice(market).minus(offset);
    const price = makerPrice(side, target, market);
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
    this.budget.take(1, now, this.settings.maxActionsPerMinute);
    if (this.execution === 'live' && this.liveBroker) {
      this.placeLiveOrder(robot, side, price, quantity.toFixed(), true, now).catch(error => {
        this.log('warning', 'order', `实盘减仓挂单失败：${error instanceof Error ? error.message : error}`, robot, now);
      });
    } else {
      this.orders.push({ id: randomUUID(), robotId: robot.id, symbol: robot.symbol, side, price,
        quantity: quantity.toFixed(), remaining: quantity.toFixed(), reduceOnly: true, createdAt: now, timeInForce: 'GTX', status: 'NEW' });
    }
    robot.lastQuoteAt = now;
    this.log('info', 'order', `只减仓 Maker ${side === 'SELL' ? '卖单' : '买单'} ${quantity.toFixed()} @ ${price}，等待成交`, robot, now);
  }

  private async placeLiveOrder(robot: Robot, side: 'BUY' | 'SELL', price: string, quantity: string, reduceOnly: boolean, now: number): Promise<FuturesOrder> {
    if (!this.liveBroker) throw new Error('实盘连接器未初始化');
    const clientOrderId = `pm-${robot.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    // 双向持仓模式下必须以 positionSide 指定方向（LONG/SHORT），此时不能同时使用 reduceOnly。
    const positionSide: 'LONG' | 'SHORT' = side === 'BUY' ? 'LONG' : 'SHORT';
    // 双向持仓模式下，positionSide 已确定减仓方向；reduceOnly 仅适用于单向（BOTH）模式。
    const withReduceOnly = reduceOnly && !positionSide;
    const order = await this.liveBroker.placeLimitOrder({ symbol: robot.symbol, side, quantity, price,
      postOnly: true, reduceOnly: withReduceOnly, positionSide, clientOrderId, workingType: 'CONTRACT_PRICE' });
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
