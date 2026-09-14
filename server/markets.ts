import { z } from 'zod';
import type { AppState, Instrument, Market, QuoteAsset } from '../shared/types';
import { D, floorStep, validMarket } from './math';
import { BinanceReadOnlyClient, type PublicRead } from './binance-readonly';

const samples = [
  ['BTC', 79149, 0.1, 0.001, 2493000000, 0.55],
  ['ETH', 2496.5, 0.01, 0.001, 2158000000, 0.16],
  ['SOL', 103.69, 0.01, 0.01, 190100000, 0.11],
  ['XRP', 1.4243, 0.0001, 0.1, 134000000, 1.82],
  ['BNB', 754.56, 0.01, 0.01, 60112000, -0.19],
  ['DOGE', 0.0904, 0.00001, 1, 34100900, 0.44],
  ['SUI', 0.8106, 0.0001, 1, 24267900, -2.03],
  ['ARB', 0.1726, 0.0001, 1, 23508600, -1.86],
  ['NEAR', 2.432, 0.001, 0.1, 23386900, 4.15],
  ['AVAX', 25.64, 0.001, 0.1, 22458000, 1.21],
  ['ADA', 0.3471, 0.0001, 1, 20112000, 0.82],
  ['LINK', 11.53, 0.001, 0.1, 18771000, -0.36],
] as const;

export function sampleMarkets(now = Date.now()): Market[] {
  return (['USDC', 'USDT'] as QuoteAsset[]).flatMap(asset => samples.map(([base, price, tick, step, volume, change], index) => {
    const history = Array.from({ length: 91 }, (_, i) => ({
      time: now - (90 - i) * 1000,
      price: price * (1 + Math.sin(i * 0.14 + index) * 0.0008 + Math.cos(i * 0.047) * 0.0012),
    }));
    history[90].price = price;
    return {
      symbol: `${base}${asset}`, baseAsset: base, quoteAsset: asset,
      priceTick: String(tick), quantityStep: String(step), minQty: String(step),
      maxQty: '100000000', minNotional: '5',
      bid: floorStep(D(price).mul(0.99994), tick).toFixed(),
      ask: floorStep(D(price).mul(1.00006), tick).plus(tick).toFixed(),
      bidQty: D(700).div(price).toFixed(), askQty: D(700).div(price).toFixed(),
      markPrice: String(price), changePercent: change,
      quoteVolume: volume * (asset === 'USDT' ? 3.9 : 1), updatedAt: now, history,
    };
  }));
}

export class SimulatedFeed {
  private randomState = 72831;
  private tickIndex = 0;
  private freezeUntil = 0;
  private shock = 1;
  private random() {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }
  scenario(type: 'surge' | 'crash' | 'disconnect', now: number) {
    if (type === 'disconnect') this.freezeUntil = now + 16000;
    else this.shock = type === 'surge' ? 1.04 : 0.96;
  }
  tick(markets: Market[], now: number): Market[] | null {
    if (now < this.freezeUntil) return null;
    this.tickIndex++;
    const shock = this.shock;
    this.shock = 1;
    return markets.map((market, i) => {
      const drift = (this.random() - 0.5) * 0.00045 + Math.sin(this.tickIndex / 17 + i) * 0.00004;
      const price = D(market.markPrice).mul(1 + drift).mul(shock);
      const bid = floorStep(price.mul(0.99994), market.priceTick);
      const ask = floorStep(price.mul(1.00006), market.priceTick).plus(market.priceTick);
      return { ...market, bid: bid.toFixed(), ask: ask.toFixed(), markPrice: price.toFixed(),
        bidQty: D(600 + this.random() * 400).div(price).toFixed(), askQty: D(600 + this.random() * 400).div(price).toFixed(),
        changePercent: market.changePercent + drift * 100 + (shock - 1) * 100,
        updatedAt: now, history: [...market.history, { time: now, price: price.toNumber() }].slice(-180),
      };
    });
  }
}

const filterSchema = z.object({
  filterType: z.string(), tickSize: z.string().optional(), stepSize: z.string().optional(),
  minQty: z.string().optional(), maxQty: z.string().optional(), notional: z.string().optional(), minNotional: z.string().optional(),
});
const exchangeSchema = z.object({ symbols: z.array(z.object({
  symbol: z.string(), baseAsset: z.string(), quoteAsset: z.string(), marginAsset: z.string(),
  status: z.string(), contractType: z.string(), filters: z.array(filterSchema),
})) });
const positive = z.string().refine(s => { try { return D(s).isFinite() && D(s).gt(0); } catch { return false; } });
const nonNegative = z.string().refine(s => { try { return D(s).isFinite() && D(s).gte(0); } catch { return false; } });
const bookSchema = z.array(z.object({ symbol: z.string(), bidPrice: positive, askPrice: positive, bidQty: nonNegative, askQty: nonNegative, time: z.number().int().positive() }));
const tickerSchema = z.array(z.object({ symbol: z.string(), quoteVolume: nonNegative, priceChangePercent: z.string() }));
const markSchema = z.array(z.object({ symbol: z.string(), markPrice: positive, time: z.number().int().positive() }));

function validRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  return z.array(z.unknown()).parse(value).flatMap(row => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parseInstruments(value: unknown): Instrument[] {
  return exchangeSchema.parse(value).symbols.filter(s =>
    s.status === 'TRADING' && s.contractType === 'PERPETUAL'
    && ['USDT', 'USDC'].includes(s.quoteAsset) && s.quoteAsset === s.marginAsset,
  ).flatMap(s => {
    const price = s.filters.find(f => f.filterType === 'PRICE_FILTER');
    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
    const minimum = s.filters.find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
    const minNotional = minimum?.notional ?? minimum?.minNotional;
    if (!price?.tickSize || !lot?.stepSize || !lot.minQty || !lot.maxQty || !minNotional) return [];
    if (![price.tickSize, lot.stepSize, lot.minQty, lot.maxQty, minNotional].every(v => positive.safeParse(v).success)) return [];
    return [{ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset as QuoteAsset,
      priceTick: price.tickSize, quantityStep: lot.stepSize, minQty: lot.minQty, maxQty: lot.maxQty, minNotional }];
  });
}

export function mergePublicMarkets(instruments: Instrument[], books: unknown, marks: unknown, tickers: unknown, previous: Market[], now: number): Market[] {
  const bookMap = new Map(validRows(bookSchema.element, books).map(b => [b.symbol, b]));
  const markMap = new Map(validRows(markSchema.element, marks).map(m => [m.symbol, m]));
  const tickerMap = new Map(validRows(tickerSchema.element, tickers).map(t => [t.symbol, t]));
  const oldMap = new Map(previous.map(m => [m.symbol, m]));
  return instruments.flatMap(instrument => {
    const book = bookMap.get(instrument.symbol), mark = markMap.get(instrument.symbol), ticker = tickerMap.get(instrument.symbol);
    if (!book || !mark || !ticker) return [];
    const updatedAt = Math.min(book.time, mark.time, now);
    if (mark.time > now + 5000 || book.time > now + 5000) return [];
    const price = Number(mark.markPrice), changePercent = Number(ticker.priceChangePercent), quoteVolume = Number(ticker.quoteVolume);
    if (![price, changePercent, quoteVolume].every(Number.isFinite)) return [];
    const history = oldMap.get(instrument.symbol)?.history ?? [];
    const market: Market = { ...instrument, bid: book.bidPrice, ask: book.askPrice,
      bidQty: book.bidQty, askQty: book.askQty, markPrice: mark.markPrice,
      quoteVolume, changePercent, updatedAt,
      history: [...history, { time: updatedAt, price }].slice(-180),
    };
    return validMarket(market) ? [market] : [];
  });
}

/**
 * 币安公开行情（REST 轮询）。
 * 说明：本网络（代理出口）实测 futures 的 WebSocket 各类流均不稳定（@arr 流收不到、
 * 连接 1-2 秒即断），故保持 REST 轮询。真正的限权风险点（openOrders 每秒全市场轮询）
 * 已在 engine.syncLiveOrders 中修复为 15s + 按币种。此处轮询节奏：盘口/标记价 5s，
 * 24h 统计 60s，规则列表 1h，并带失败退避，稳态权重约 600/min，远低于 2400 上限。
 */
export class BinancePublicFeed {
  private http = new BinanceReadOnlyClient({ environment: 'production' });
  private instruments: Instrument[] = [];
  private tickers: z.infer<typeof tickerSchema> = [];
  private lastMetadata = 0;
  private lastTicker = 0;
  private nextPoll = 0;
  private failures = 0;
  private busy = false;
  private generation = 0;
  status: AppState['feed'] = { status: 'connecting', message: '正在连接币安公开行情', updatedAt: 0 };

  reset() {
    this.generation++;
    this.instruments = []; this.lastMetadata = 0; this.lastTicker = 0; this.nextPoll = 0;
    this.failures = 0;
    this.status = { status: 'connecting', message: '正在连接币安公开行情', updatedAt: 0 };
  }

  async request(path: string): Promise<unknown> {
    const paths: Record<string, PublicRead> = {
      '/fapi/v1/exchangeInfo': 'exchangeInfo', '/fapi/v1/ticker/24hr': 'ticker24h',
      '/fapi/v1/ticker/bookTicker': 'bookTicker', '/fapi/v1/premiumIndex': 'premiumIndex',
    };
    if (!Object.hasOwn(paths, path)) throw new Error('只允许配置中的公开行情查询');
    try { return await this.http.publicData(paths[path]); }
    finally { this.nextPoll = Math.max(this.nextPoll, this.http.blockedUntil); }
  }

  async poll(previous: Market[], now: number, watchedSymbols: string[] = []): Promise<Market[] | null> {
    if (this.busy || now < this.nextPoll) return null;
    this.busy = true;
    const generation = this.generation;
    try {
      if (now - this.lastMetadata > 3600000 || !this.instruments.length) {
        const instruments = parseInstruments(await this.request('/fapi/v1/exchangeInfo'));
        if (!instruments.length) throw new Error('接口未返回可用的 U 本位永续交易规则');
        this.instruments = instruments; this.lastMetadata = now;
      }
      if (now - this.lastTicker > 60000) {
        this.tickers = validRows(tickerSchema.element, await this.request('/fapi/v1/ticker/24hr'));
        this.lastTicker = now;
      }
      const [books, marks] = await Promise.all([
        this.request('/fapi/v1/ticker/bookTicker'), this.request('/fapi/v1/premiumIndex'),
      ]);
      if (generation !== this.generation) return null;
      const eligible = new Map(this.instruments.map(i => [i.symbol, i]));
      const tracked = new Set(watchedSymbols);
      for (const asset of ['USDC', 'USDT']) {
        this.tickers.filter(t => eligible.get(t.symbol)?.quoteAsset === asset)
          .sort((a, b) => D(b.quoteVolume).cmp(a.quoteVolume)).slice(0, 10)
          .forEach(t => tracked.add(t.symbol));
      }
      const markets = mergePublicMarkets(this.instruments.filter(i => tracked.has(i.symbol)), books, marks, this.tickers, previous, Date.now());
      if (!markets.length) throw new Error('公开行情缺少有效盘口或标记价格');
      this.failures = 0; this.nextPoll = Date.now() + 5000;
      this.status = { status: 'connected', message: '币安公开行情 · 连接正常', updatedAt: Date.now() };
      return markets;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.failures++;
      this.nextPoll = Math.max(this.nextPoll, Date.now() + Math.min(60000, 5000 * 2 ** this.failures));
      this.status = { status: 'error', message: `${error instanceof Error ? error.message : '行情读取失败'}`, updatedAt: this.status.updatedAt };
      return null;
    } finally { this.busy = false; }
  }
}