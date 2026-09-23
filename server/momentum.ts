// 行情趋势榜单引擎（momentum）
// 思路（用户朋友的方案）：每 N 秒扫一次合约 24h 涨跌幅榜，只做排名前 K 的币；
// 用 1 分钟 Supertrend 判定方向——上升做多、下降做空；趋势翻转则反手；
// 币掉出榜单则平仓离场。全部用市价单（TAKER 低费率场景）。
//
// 与 MakerEngine 完全独立：不共享挂单/持仓状态机，只复用交易客户端与 K 线获取。
// 全链路故障静默：任何一步失败都只记日志，不影响下一周期。

import { z } from 'zod';
import type { BinanceTradingClient, FuturesPosition } from './binance-trading';
import { makeBinanceKlinesFetcher, type KlineInterval } from './klines';
import { supertrend, type Candle } from './supertrend';
import { floorStep, ceilStep } from './math';

export interface MomentumConfig {
  topCount: number;
  tickSeconds: number;
  orderNotional: number;
  atrWindow: number;
  atrMultiplier: number;
  interval: KlineInterval;
  quoteAssets: string[];
  minQuoteVolume: number;
  /** 反手冷却秒数：同一币刚反手后，此时间内不再重复反手（防止锯齿市里反复横跳打脸） */
  flipCooldownSeconds: number;
  /** 趋势引擎持仓总名义上限（U）：防止与 Maker 网格争占同一账户保证金/collateral */
  maxTotalNotional: number;
  /** 只做多模式：true 时忽略做空信号（做空在高磨损小币上胜率低，实测 ZETA/AKE 空单拖累） */
  longOnly: boolean;
  /** 追高保护（%）：24h 涨幅超过该阈值视为过热，跳过开多，避免追在顶部（实测 AGT +64% 追多亏 2.1U） */
  maxChasePct: number;
  /** 持仓止损（%）：开仓后回撤超过该比例即市价平仓，防止单边深套 */
  stopLossPct: number;
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  topCount: 3, tickSeconds: 60, orderNotional: 1,
  atrWindow: 3, atrMultiplier: 1.5, interval: '1m',
  quoteAssets: ['USDT'], minQuoteVolume: 1_000_000,
  flipCooldownSeconds: 60,
  maxTotalNotional: 30,
  longOnly: true,
  maxChasePct: 30,
  stopLossPct: 5,
};

export interface MomentumConfigSchema {
  topCount?: number; tickSeconds?: number; orderNotional?: number;
  atrWindow?: number; atrMultiplier?: number; interval?: string;
  quoteAssets?: string[]; minQuoteVolume?: number;
  flipCooldownSeconds?: number; maxTotalNotional?: number;
  longOnly?: boolean;
  maxChasePct?: number;
  stopLossPct?: number;
}

const klineRowSchema = z.tuple([
  z.number().int(), z.string(), z.string(), z.string(), z.string(), z.string(),
  z.number().int(),
]).rest(z.unknown()); // 币安 klines 返 12 列，前 7 列含 openTime/open/high/low/close/volume/closeTime

export interface OpenPosition { symbol: string; side: 'LONG' | 'SHORT'; qty: number; entryPrice: number; openedAt: number; lastFlipAt: number }

export interface MomentumState {
  enabled: boolean;
  config: MomentumConfig;
  lastCycleAt: number;
  cycleCount: number;
  lastError: string;
  positions: OpenPosition[];
  lastRanking: Array<{ symbol: string; changePct: number; volume: number; direction: 1 | -1 | 'FLAT' | 'NA'; reason: string }>;
  events: Array<{ time: number; message: string; level: 'info' | 'warning' | 'error' }>;
}

interface EventLog { time: number; message: string; level: 'info' | 'warning' | 'error' }

export class MomentumEngine {
  state: MomentumState;
  private klines = makeBinanceKlinesFetcher({ endpoint: 'fapi' });
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private events: EventLog[] = [];
  private stepSizeCache = new Map<string, number>();
  private minNotionalCache = new Map<string, number>();
  /** 最近一次查到的实时价缓存（用于估算持仓名义） */
  private lastPriceCache = new Map<string, number>();

  constructor(
    private broker: BinanceTradingClient,
    config: Partial<MomentumConfig> = {},
  ) {
    this.state = {
      enabled: false, config: { ...DEFAULT_MOMENTUM_CONFIG, ...config },
      lastCycleAt: 0, cycleCount: 0, lastError: '', positions: [], lastRanking: [], events: [],
    };
  }

  updateConfig(partial: MomentumConfigSchema) {
    const raw = { ...this.state.config, ...partial };
    this.state.config = {
      topCount: clampInt(raw.topCount, 1, 10, 3),
      tickSeconds: clampInt(raw.tickSeconds, 5, 600, 60),
      orderNotional: clamp(raw.orderNotional, 0.5, 100, 1),
      atrWindow: clampInt(raw.atrWindow, 2, 20, 3),
      atrMultiplier: clamp(raw.atrMultiplier, 0.5, 6, 1.5),
      interval: ['1m', '5m', '15m', '30m', '1h'].includes(raw.interval ?? '') ? raw.interval as KlineInterval : '1m',
      quoteAssets: Array.isArray(raw.quoteAssets) && raw.quoteAssets.length ? raw.quoteAssets.filter(a => ['USDT', 'USDC'].includes(a)) : ['USDT'],
      minQuoteVolume: clamp(raw.minQuoteVolume, 0, 1e9, 1_000_000),
      flipCooldownSeconds: clampInt(raw.flipCooldownSeconds, 0, 3600, 60),
      maxTotalNotional: clamp(raw.maxTotalNotional, 5, 10000, 30),
      longOnly: raw.longOnly !== false, // 默认开启只做多
      maxChasePct: clamp(raw.maxChasePct, 5, 200, 30),
      stopLossPct: clamp(raw.stopLossPct, 0.5, 50, 5),
    };
  }

  async start() {
    if (this.state.enabled) return;
    if (!this.broker.configured) throw new Error('实盘交易凭据未配置，无法启动趋势引擎');
    this.state.enabled = true;
    this.log('info', '趋势引擎已启动');
    await this.cycle();
    if (!this.timer) this.timer = setInterval(() => void this.cycle(), this.state.config.tickSeconds * 1000);
  }

  async stop() {
    this.state.enabled = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.log('info', '趋势引擎已停止');
  }

  /** 立即平掉全部持仓（紧急用），市价平仓 */
  async flatten() {
    for (const pos of [...this.state.positions]) {
      await this.closePosition(pos);
    }
    this.state.positions = [];
  }

  private log(level: 'info' | 'warning' | 'error', message: string) {
    const entry: EventLog = { time: Date.now(), message, level };
    this.events.push(entry);
    this.state.events = this.events.slice(-80);
  }

  /** 拉 24h ticker，过滤并按涨跌幅绝对值排名 */
  private async fetchRanking(): Promise<Array<{ symbol: string; changePct: number; volume: number }>> {
    const rows: unknown = await this.fetchPublic('/fapi/v1/ticker/24hr');
    const tickers = z.array(z.object({
      symbol: z.string(), priceChangePercent: z.string(), quoteVolume: z.string(),
    })).parse(rows);
    const eligible = tickers.filter(t => {
      const quote = this.state.config.quoteAssets.find(q => t.symbol.endsWith(q));
      if (!quote) return false;
      const volume = Number(t.quoteVolume);
      const change = Math.abs(Number(t.priceChangePercent));
      return Number.isFinite(volume) && Number.isFinite(change) && volume >= this.state.config.minQuoteVolume && change > 0.01;
    });
    return eligible
      .sort((a, b) => Math.abs(Number(b.priceChangePercent)) - Math.abs(Number(a.priceChangePercent)))
      .slice(0, this.state.config.topCount)
      .map(t => ({ symbol: t.symbol, changePct: Number(t.priceChangePercent), volume: Number(t.quoteVolume) }));
  }

  /** 公开接口（无鉴权）请求：ticker / 标记价格 / 实时价 / 交易规则 */
  private async fetchPublic(path: '/fapi/v1/ticker/24hr' | '/fapi/v1/ticker/price' | '/fapi/v1/ticker/bookTicker' | '/fapi/v1/exchangeInfo', symbol?: string): Promise<unknown> {
    const base = 'https://fapi.binance.com';
    const url = new URL(base + path);
    if (symbol) url.searchParams.set('symbol', symbol);
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`行情请求失败 HTTP ${response.status}`);
    return response.json();
  }

  /** 拉 1 分钟 K 线 → Candle */
  private async fetchCandles(symbol: string): Promise<Candle[] | null> {
    try {
      const rows = await this.klines.fetchKlines(symbol, this.state.config.interval, 60);
      const candles: Candle[] = [];
      for (const row of rows) {
        const parsed = klineRowSchema.safeParse(row);
        if (!parsed.success) continue;
        const [, open, high, low, close] = parsed.data;
        const c = { high: Number(high), low: Number(low), close: Number(close) };
        if (Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && c.high >= c.low) candles.push(c);
      }
      // 币安返回的最后一根 K 线是「进行中」的未收盘 K 线，其 OHLC 每几秒都在变。
      // 若把它喂给 Supertrend，同一根 K 线在轮询期间会被反复重算方向，造成十秒级
      // "横跳"反手（实测 ZETA 一小时 25 笔、净亏 0.18U）。这里始终丢弃最后一根，
      // 让指标只基于完整收盘的 K 线，保证一轮轮询内方向稳定。
      candles.pop();
      return candles.length >= 8 ? candles : null;
    } catch { return null; }
  }

  /** 从币安拉真实持仓，重算本地 positions（以交易所为准） */
  private async syncPositions(): Promise<void> {
    try {
      const positions = await this.broker.getPositions() as FuturesPosition[];
      const bySymbol = new Map(positions.filter(p => Math.abs(Number(p.positionAmt)) > 0).map(p => [p.symbol, p]));
      const next: OpenPosition[] = [];
      for (const pos of this.state.positions) {
        const live = bySymbol.get(pos.symbol);
        if (live && Math.abs(Number(live.positionAmt)) > 0) {
          next.push({ ...pos, side: Number(live.positionAmt) > 0 ? 'LONG' : 'SHORT', qty: Math.abs(Number(live.positionAmt)), entryPrice: Number(live.entryPrice) });
        }
      }
      this.state.positions = next;
    } catch (error) {
      this.log('warning', `同步持仓失败：${error instanceof Error ? error.message : '网络错误'}`);
    }
  }

  private async closePosition(pos: OpenPosition): Promise<void> {
    const side = pos.side === 'LONG' ? 'SELL' : 'BUY';
    try {
      const qty = pos.qty.toFixed(8);
      await this.broker.placeMarketOrder({ symbol: pos.symbol, side, quantity: qty, reduceOnly: true });
      this.log('info', `平仓 ${pos.symbol} ${pos.side} ${qty}（市价 ${side}）`);
    } catch (error) {
      this.log('error', `平仓失败 ${pos.symbol}：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  private async openPosition(symbol: string, side: 'LONG' | 'SHORT'): Promise<void> {
    const qty = await this.notionalToQty(symbol, this.state.config.orderNotional);
    const buy = side === 'LONG' ? 'BUY' : 'SELL';
    try {
      // 设置适中的杠杆（默认 3x），避免新币种默认杠杆超上限被拒（-2027）
      try { await this.broker.setLeverage(symbol, 3); } catch { /* 杠杆已就绪则忽略 */ }
      await this.broker.placeMarketOrder({ symbol, side: buy, quantity: qty.toFixed(8) });
      this.log('info', `开仓 ${symbol} ${side} ${qty.toFixed(8)}（市价 ${buy}）`);
      const existing = this.state.positions.find(p => p.symbol === symbol);
      if (existing) { existing.side = side; existing.openedAt = Date.now(); existing.lastFlipAt = Date.now(); }
      else this.state.positions.push({ symbol, side, qty, entryPrice: 0, openedAt: Date.now(), lastFlipAt: Date.now() });
    } catch (error) {
      this.log('error', `开仓失败 ${symbol}：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /** 拉 exchangeInfo 取该合约的 LOT_SIZE stepSize 与最小名义，缓存 */
  private async instrumentRules(symbol: string): Promise<{ step: number; minNotional: number } | null> {
    if (this.stepSizeCache.has(symbol)) {
      return { step: this.stepSizeCache.get(symbol)!, minNotional: this.minNotionalCache.get(symbol) ?? 5 };
    }
    try {
      const raw = await this.fetchPublic('/fapi/v1/exchangeInfo') as unknown;
      const info = z.object({ symbols: z.array(z.object({
        symbol: z.string(),
        filters: z.array(z.object({ filterType: z.string(), stepSize: z.string().optional(), notional: z.string().optional() })),
      })) }).parse(raw);
      const sym = info.symbols.find(s => s.symbol === symbol);
      if (!sym) return null;
      const lot = sym.filters.find(f => f.filterType === 'LOT_SIZE');
      const notional = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
      const step = lot?.stepSize ? Number(lot.stepSize) : 0.0001;
      const minNotional = Number(notional?.notional ?? 5);
      this.stepSizeCache.set(symbol, step);
      this.minNotionalCache.set(symbol, minNotional);
      return { step, minNotional };
    } catch { return null; }
  }

  /** 金额 → 对齐 stepSize 的币数量。币安最小名义约束：单笔 notional 不得 < 5U（-4164），
    向上取整到 step，并留 5% 缓冲（币安按 lastPrice 校验名义，盘口价会有偏差）。 */
  private async notionalToQty(symbol: string, notional: number): Promise<number> {
    const price = await this.lastPrice(symbol);
    if (!price) throw new Error(`无法获取 ${symbol} 最新价`);
    const rules = await this.instrumentRules(symbol);
    const step = rules?.step ?? 0.0001;
    const minNotional = rules?.minNotional ?? 5;
    const effective = Math.max(notional, minNotional) * 1.05; // 缓冲 5%
    return Math.max(step, ceilStep(effective / price, step).toNumber());
  }

  private async lastPrice(symbol: string): Promise<number | null> {
    try {
      const raw = await this.fetchPublic('/fapi/v1/ticker/price', symbol) as unknown;
      const tick = z.object({ symbol: z.string(), price: z.string() }).parse(Array.isArray(raw) ? raw[0] : raw);
      const p = Number(tick.price);
      if (Number.isFinite(p) && p > 0) { this.lastPriceCache.set(symbol, p); return p; }
      return null;
    } catch { return null; }
  }

  /** 单轮循环：排行 → 各币方向 → 开/反/平 */
  async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      const ranking = await this.fetchRanking();
      this.state.lastRanking = [];
      await this.syncPositions();
      const now = Date.now();

      const rankedSymbols = new Set(ranking.map(r => r.symbol));
      // 1) 掉榜的持仓 → 平仓
      for (const pos of [...this.state.positions]) {
        if (!rankedSymbols.has(pos.symbol)) {
          await this.closePosition(pos);
          this.state.positions = this.state.positions.filter(p => p.symbol !== pos.symbol);
        }
      }

      // 1.5) 持仓止损：开仓后浮亏超过 stopLossPct → 市价平仓，防止单边深套（AGT 单币 -2.1U 的教训）
      for (const pos of [...this.state.positions]) {
        if (pos.entryPrice <= 0) continue;
        const px = this.lastPriceCache.get(pos.symbol) ?? await this.lastPrice(pos.symbol);
        if (!px) continue;
        const pnlPct = pos.side === 'LONG' ? (px - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - px) / pos.entryPrice;
        if (pnlPct * 100 <= -this.state.config.stopLossPct) {
          this.log('warning', `止损触发 ${pos.symbol} ${pos.side} 浮亏 ${(pnlPct * 100).toFixed(2)}% ≤ -${this.state.config.stopLossPct}%，市价平仓`);
          await this.closePosition(pos);
          this.state.positions = this.state.positions.filter(p => p.symbol !== pos.symbol);
        }
      }

      // 2) 榜内币 → 按 Supertrend 决定方向
      for (const item of ranking) {
        const candles = await this.fetchCandles(item.symbol);
        const st = candles ? supertrend(candles, this.state.config.atrWindow, this.state.config.atrMultiplier) : null;
        const direction: 1 | -1 | 'NA' = st ? st.direction : 'NA';
        const pos = this.state.positions.find(p => p.symbol === item.symbol);

        if (direction === 'NA') {
          this.state.lastRanking.push({ symbol: item.symbol, changePct: item.changePct, volume: item.volume, direction, reason: 'K线不足，暂不动作' });
          continue;
        }
        const wantLong = direction === 1;
        let reason = '持有不动';
        // 只做多模式：做空信号视为「观望」。已有空仓 → 平空离场（不再反手做空）
        if (this.state.config.longOnly && !wantLong) {
          if (pos?.side === 'SHORT') {
            await this.closePosition(pos);
            this.state.positions = this.state.positions.filter(p => p.symbol !== item.symbol);
            reason = '只做多模式：趋势向下，平空离场';
          } else if (pos) {
            reason = '只做多模式：趋势向下，多仓持有等待';
          } else {
            reason = '只做多模式：做空信号忽略';
          }
          this.state.lastRanking.push({ symbol: item.symbol, changePct: item.changePct, volume: item.volume, direction, reason });
          continue;
        }
        // 反手冷却：同一币刚反手过，冷却期内即便方向相反也先观望，
        // 避免锯齿市里一根 K 线内来回横跳（磨损来源）。
        const pendingFlip = pos && pos.side !== (wantLong ? 'LONG' : 'SHORT');
        if (pendingFlip && now - pos.lastFlipAt < this.state.config.flipCooldownSeconds * 1000) {
          reason = `反手冷却中（${Math.ceil((this.state.config.flipCooldownSeconds * 1000 - (now - pos.lastFlipAt)) / 1000)}s）`;
          this.state.lastRanking.push({ symbol: item.symbol, changePct: item.changePct, volume: item.volume, direction, reason });
          continue;
        }
        // 趋势引擎持仓总名义上限：超出后不再新开仓，防止与 Maker 网格争保证金
        const totalNotional = this.state.positions.reduce((s, p) => {
          const px = this.lastPriceCache.get(p.symbol);
          return s + (px ? p.qty * px : 0);
        }, 0);
        if (!pos && totalNotional >= this.state.config.maxTotalNotional) {
          reason = '持仓已达趋势引擎名义上限，暂缓开新仓';
          this.state.lastRanking.push({ symbol: item.symbol, changePct: item.changePct, volume: item.volume, direction, reason });
          continue;
        }
        if (!pos) {
          // 追高保护：24h 涨幅过高（过热）时跳过开多——AGT +64% 追多实测亏 2.1U 的教训
          if (wantLong && this.state.config.longOnly && item.changePct > this.state.config.maxChasePct) {
            reason = `追高保护：24h 涨幅 ${item.changePct.toFixed(1)}% 超过阈值 ${this.state.config.maxChasePct}%，跳过`;
            this.state.lastRanking.push({ symbol: item.symbol, changePct: item.changePct, volume: item.volume, direction, reason });
            continue;
          }
          await this.openPosition(item.symbol, wantLong ? 'LONG' : 'SHORT');
          reason = `新开${wantLong ? '多' : '空'}`;
        } else if (pos.side === 'LONG' && !wantLong) {
          await this.closePosition(pos);
          this.state.positions = this.state.positions.filter(p => p.symbol !== item.symbol);
          await this.openPosition(item.symbol, 'SHORT');
          reason = '趋势向下，反手做空';
        } else if (pos.side === 'SHORT' && wantLong) {
          await this.closePosition(pos);
          this.state.positions = this.state.positions.filter(p => p.symbol !== item.symbol);
          await this.openPosition(item.symbol, 'LONG');
          reason = '趋势向上，反手做多';
        }
        this.state.lastRanking.push({ symbol: item.symbol, changePct: item.changePct, volume: item.volume, direction, reason });
      }
      this.state.lastCycleAt = now;
      this.state.cycleCount++;
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : '未知错误';
      this.log('error', `周期失败：${this.state.lastError}`);
    } finally {
      this.running = false;
    }
  }
}

function clamp(value: unknown, min: number, max: number, def: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
function clampInt(value: unknown, min: number, max: number, def: number): number {
  return Math.round(clamp(value, min, max, def));
}