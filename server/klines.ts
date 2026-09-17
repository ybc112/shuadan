// 币安 K 线采集与摘要化（量化数据层）
// 职责：
//   1) 按周期拉取币安公开 K 线（永续 fapi 或现货，均可配置）
//   2) 把原始 K 线压缩成喂给 AI 的"数字摘要"（最新价/涨跌幅/高低波动/成交量/趋势）
// 设计约束：
//   - 只读公开接口，无鉴权
//   - 全链路错误静默降级：拉取失败返回 null，不影响引擎主循环
//   - 摘要化产物是纯 JSON 数字，供 commander 组装 prompt 使用

import { z } from 'zod';

export type KlineInterval =
  | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '1d';

export const KLINE_INTERVALS: KlineInterval[] = ['5m', '30m', '2h', '1d'];

export interface KlineSummary {
  interval: KlineInterval;
  symbol: string;
  /** 当前（最新收盘）价 */
  lastPrice: number;
  /** 当前周期涨跌幅 %（相对本周期开盘） */
  changePct: number;
  /** 前一个周期涨跌幅 %（动量参考） */
  prevChangePct: number;
  /** 最近 24 根 K 线的最高/低价 */
  high24: number;
  low24: number;
  /** 振幅 = (high24-low24)/lastPrice*100（波动率代理） */
  amplitudePct: number;
  /** 最近 24 根 K 线成交量均值 */
  avgVolume: number;
  /** 最近 48 根（约两倍窗口）收盘价平均 vs 24 根平均的漂移方向，+1 上升 -1 下降 0 持平 */
  trend: 1 | -1 | 0;
}

const klineRowSchema = z.tuple([
  z.number().int(), // openTime
  z.string(), // open
  z.string(), // high
  z.string(), // low
  z.string(), // close
  z.string(), // volume
  z.number().int(), // closeTime
  z.string(), // quoteVol
  z.number().int(), // trades
]);

interface KlinesFetcher {
  fetchKlines(symbol: string, interval: KlineInterval, limit: number): Promise<unknown[]>;
}

/** 默认实现：直接 fetch 币安公开接口。可注入以便测试。 */
export function makeBinanceKlinesFetcher(
  opts: { endpoint?: 'fapi' | 'spot'; baseUrl?: string; fetchFn?: typeof fetch } = {},
): KlinesFetcher {
  const base =
    opts.baseUrl ??
    (opts.endpoint === 'spot' ? 'https://api.binance.com' : 'https://fapi.binance.com');
  const path = opts.endpoint === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    async fetchKlines(symbol, interval, limit) {
      const url = new URL(base + path);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('interval', interval);
      url.searchParams.set('limit', String(limit));
      const response = await fetchFn(url.toString(), { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`K线请求失败 HTTP ${response.status}`);
      return response.json();
    },
  };
}

/** 从原始 K 线数组计算出摘要。原始行格式见 klineRowSchema（币安 klines 返回）。 */
export function summarizeKlines(
  symbol: string,
  interval: KlineInterval,
  rows: unknown[],
  now = Date.now(),
): KlineSummary | null {
  if (!Array.isArray(rows) || rows.length < 4) return null;
  const parsed: { open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (const row of rows) {
    const r = klineRowSchema.safeParse(row);
    if (!r.success) continue;
    const [, open, high, low, close, volume] = r.data;
    const p = { open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
    if ([p.open, p.high, p.low, p.close, p.volume].every(Number.isFinite) && p.high >= p.low && p.close > 0) {
      parsed.push(p);
    }
  }
  if (parsed.length < 4) return null;

  const last = parsed[parsed.length - 1];
  const prev = parsed[parsed.length - 2];
  const window24 = parsed.slice(-24);
  const window48 = parsed.slice(-48);

  const high24 = Math.max(...window24.map((k) => k.high));
  const low24 = Math.min(...window24.map((k) => k.low));
  const avgVolume = window24.reduce((s, k) => s + k.volume, 0) / window24.length;
  const amplitudePct = ((high24 - low24) / last.close) * 100;

  // 趋势：48 根平均价 vs 24 根平均价
  const avg48 = window48.reduce((s, k) => s + k.close, 0) / window48.length;
  const avg24 = window24.reduce((s, k) => s + k.close, 0) / window24.length;
  const driftPct = ((avg24 - avg48) / avg48) * 100;
  const trend: 1 | -1 | 0 = driftPct > 0.05 ? 1 : driftPct < -0.05 ? -1 : 0;

  return {
    interval,
    symbol,
    lastPrice: last.close,
    changePct: last.open > 0 ? ((last.close - last.open) / last.open) * 100 : 0,
    prevChangePct: prev.open > 0 ? ((prev.close - prev.open) / prev.open) * 100 : 0,
    high24,
    low24,
    amplitudePct,
    avgVolume,
    trend,
  };
}

/** 定时采集器：按周期轮询一批标的的 K 线，失败单周期静默跳过。 */
export class KlineCollector {
  private cache = new Map<string, KlineSummary[]>();

  constructor(
    private fetcher: KlinesFetcher,
    private opts: { intervals?: KlineInterval[] } = {},
  ) {
    this.opts.intervals ??= KLINE_INTERVALS;
  }

  snapshot(symbol: string): KlineSummary[] {
    return this.cache.get(symbol) ?? [];
  }

  all(): Map<string, KlineSummary[]> {
    return this.cache;
  }

  async refresh(symbols: string[]): Promise<void> {
    const intervals = this.opts.intervals ?? [];
    for (const symbol of symbols) {
      const summaries: KlineSummary[] = [];
      for (const interval of intervals) {
        try {
          const rows = await this.fetcher.fetchKlines(symbol, interval, 48);
          const summary = summarizeKlines(symbol, interval, rows);
          if (summary) summaries.push(summary);
        } catch {
          // 单个周期失败不影响其它周期
        }
      }
      if (summaries.length > 0) this.cache.set(symbol, summaries);
    }
  }
}

export const klineSummarySchema = z.object({
  interval: z.enum(KLINE_INTERVALS as [KlineInterval, ...KlineInterval[]]),
  symbol: z.string(),
  lastPrice: z.number(),
  changePct: z.number(),
  prevChangePct: z.number(),
  high24: z.number(),
  low24: z.number(),
  amplitudePct: z.number(),
  avgVolume: z.number(),
  trend: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});