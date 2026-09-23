import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { BinanceEnvironment } from '../shared/connection';

const ORIGINS: Record<BinanceEnvironment, string> = Object.freeze({
  demo: 'https://demo-fapi.binance.com',
  production: 'https://fapi.binance.com',
});

const TRADING_PATHS = Object.freeze({
  newOrder: '/fapi/v1/order',
  cancelOrder: '/fapi/v1/order',
  cancelAll: '/fapi/v1/allOpenOrders',
  setLeverage: '/fapi/v1/leverage',
  setMarginType: '/fapi/v1/marginType',
});
const ACCOUNT_PATHS = Object.freeze({
  account: '/fapi/v3/account',
  positions: '/fapi/v3/positionRisk',
  openOrders: '/fapi/v1/openOrders',
  allOpenOrders: '/fapi/v1/openOrders',
  userTrades: '/fapi/v1/userTrades',
});
export type TradingPath = keyof typeof TRADING_PATHS;
export type TradingAccountPath = keyof typeof ACCOUNT_PATHS;

export const symbolSchema = z.string().regex(/^[A-Z0-9]{3,30}$/, '请输入有效的合约代码');

export class BinanceTradingError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryAt = 0) {
    super(message); this.name = 'BinanceTradingError';
  }
}

export interface TradingConfig {
  environment: BinanceEnvironment;
  apiKey?: string;
  apiSecret?: string;
}

export function tradingConfigFromEnv(env: NodeJS.ProcessEnv): TradingConfig {
  const parsed = z.enum(['demo', 'production']).safeParse(env.BINANCE_LIVE_ENV ?? 'demo');
  if (!parsed.success) throw new BinanceTradingError('ENVIRONMENT_INVALID', 'BINANCE_LIVE_ENV 只能为 demo 或 production');
  const environment = parsed.data;
  return {
    environment,
    apiKey: env.BINANCE_LIVE_API_KEY?.trim() || undefined,
    apiSecret: env.BINANCE_LIVE_API_SECRET?.trim() || undefined,
  };
}

const decimalString = z.string().refine(value => {
  if (value === '' || value === undefined || value === null) return false;
  const numeric = Number(value);
  return Number.isFinite(numeric);
}, '字段必须是有限十进制数字');

const positionSideSchema = z.enum(['BOTH', 'LONG', 'SHORT']);

const accountAssetSchema = z.object({
  asset: z.string(), walletBalance: decimalString.optional(), availableBalance: decimalString.optional(),
  unrealizedProfit: decimalString.optional(), marginBalance: decimalString.optional(),
  crossWalletBalance: decimalString.optional(), crossUnPnl: decimalString.optional(),
  initialMargin: decimalString.optional(), maintMargin: decimalString.optional(),
  positionInitialMargin: decimalString.optional(), openOrderInitialMargin: decimalString.optional(),
  maxWithdrawAmount: decimalString.optional(),
});

const accountSchema = z.object({
  totalWalletBalance: decimalString, totalUnrealizedProfit: decimalString,
  totalMarginBalance: decimalString, totalPositionInitialMargin: decimalString.optional(),
  totalOpenOrderInitialMargin: decimalString.optional(), availableBalance: decimalString.optional(),
  maxWithdrawAmount: decimalString.optional(), assets: z.array(accountAssetSchema).default([]),
  positions: z.array(z.object({
    symbol: z.string(), positionSide: positionSideSchema.optional(), positionAmt: decimalString,
    entryPrice: decimalString.optional(), markPrice: decimalString.optional(), unRealizedProfit: decimalString.optional(),
    liquidationPrice: decimalString.optional(), leverage: decimalString.optional(), marginType: z.string().optional(),
    notional: decimalString.optional(), isolatedMargin: decimalString.optional(),
    initialMargin: decimalString.optional(), maintMargin: decimalString.optional(),
  })).optional(),
});

const positionSchema = z.object({
  symbol: z.string(), positionSide: positionSideSchema, positionAmt: decimalString,
  entryPrice: decimalString, markPrice: decimalString, unRealizedProfit: decimalString.optional(),
  liquidationPrice: decimalString, leverage: decimalString.optional(), marginType: z.string().optional(),
});

const orderSideSchema = z.enum(['BUY', 'SELL']);
const orderTypeSchema = z.enum(['LIMIT', 'MARKET', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET']);
const orderStatusSchema = z.enum(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

const orderSchema = z.object({
  symbol: z.string(), orderId: z.union([z.number(), z.string()]).transform(v => String(v)), clientOrderId: z.string().optional(),
  side: orderSideSchema, type: orderTypeSchema, status: orderStatusSchema,
  price: decimalString.optional(), avgPrice: decimalString.optional(),
  origQty: decimalString, executedQty: decimalString, cumQuote: decimalString.optional(),
  timeInForce: z.string().optional(), reduceOnly: z.boolean().optional(),
  closePosition: z.boolean().optional(), workingType: z.string().optional(),
  priceProtect: z.boolean().optional(), origType: z.string().optional(),
  updateTime: z.number().int().nonnegative().optional(),
  time: z.number().int().nonnegative().optional(),
});

const userTradeSchema = z.object({
  symbol: z.string(), id: z.union([z.number(), z.string()]).transform(v => String(v)).optional(), orderId: z.union([z.number(), z.string()]).transform(v => String(v)).optional(),
  side: orderSideSchema, price: decimalString, qty: decimalString,
  commission: decimalString, commissionAsset: z.string(),
  realizedPnl: decimalString, time: z.number().int().nonnegative(),
  buyer: z.boolean().optional(), maker: z.boolean().optional(),
  positionSide: positionSideSchema.optional(),
});

export interface FuturesAccount {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  totalPositionInitialMargin: string;
  totalOpenOrderInitialMargin: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  assets: { asset: string; walletBalance: string; availableBalance: string;
    unrealizedProfit: string; marginBalance: string; crossWalletBalance: string;
    crossUnPnl: string; initialMargin: string; maintMargin: string }[];
  positions: FuturesPosition[];
}

export interface FuturesPosition {
  symbol: string;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
}

export interface FuturesOrder {
  symbol: string;
  orderId: string;
  clientOrderId?: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET' | 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET';
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  price?: string;
  avgPrice?: string;
  origQty: string;
  executedQty: string;
  cumQuote?: string;
  timeInForce?: string;
  reduceOnly?: boolean;
  workingType?: string;
  updateTime?: number;
  time?: number;
}

export interface UserTrade {
  symbol: string;
  id?: string;
  orderId?: string;
  side: 'BUY' | 'SELL';
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
  realizedPnl: string;
  time: number;
  buyer?: boolean;
  maker?: boolean;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
}

export interface LiveStatus {
  environment: BinanceEnvironment;
  baseUrl: string;
  configured: boolean;
  configurationIssue: string | null;
  blockedUntil: number;
  lastWeight: number;
  ordersThisMinute: number;
  lastSyncedAt: number | null;
  lastAccountSyncAt: number | null;
  lastAccountError: string | null;
}

export class BinanceTradingClient {
  environment: BinanceEnvironment;
  baseUrl: string;
  #apiKey: string;
  #apiSecret: string;
  #fetch: typeof fetch;
  #now: () => number;
  #offset = 0;
  #syncedAt: number | null = null;
  #blockedUntil = 0;
  #configurationIssue: string | null = null;
  #lastWeight = 0;
  #lastWeightAt = 0;
  #orderTimestamps: number[] = [];
  #lastAccountSyncAt: number | null = null;
  #lastAccountError: string | null = null;
  static readonly MAX_ORDERS_PER_MINUTE = 200;
  static readonly MAX_WEIGHT_PER_MINUTE = 2400;

  constructor(config: TradingConfig, dependencies: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.environment = z.enum(['demo', 'production']).parse(config.environment);
    this.baseUrl = ORIGINS[this.environment];
    this.#apiKey = '';
    this.#apiSecret = '';
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? Date.now;
    this.configure(config);
  }

  /** Replace the trading credentials at runtime and reset clock / rate-limit state. */
  configure(config: TradingConfig): void {
    this.environment = z.enum(['demo', 'production']).parse(config.environment);
    this.baseUrl = ORIGINS[this.environment];
    this.#apiKey = config.apiKey?.trim() ?? '';
    this.#apiSecret = config.apiSecret?.trim() ?? '';
    this.#configurationIssue = null;
    const hasKey = !!this.#apiKey;
    const hasSecret = !!this.#apiSecret;
    if (!hasKey && !hasSecret) {
      this.#configurationIssue = '尚未配置交易 API Key / Secret';
    } else if (hasKey !== hasSecret) {
      this.#configurationIssue = 'API Key 与 Secret 必须同时配置';
    } else if (!/^[!-~]{16,256}$/.test(this.#apiKey) || !/^[!-~]{16,512}$/.test(this.#apiSecret)) {
      this.#configurationIssue = '交易凭据格式无效；本连接器仅支持 HMAC Key / Secret，不支持 PEM 私钥';
    }
    this.#offset = 0; this.#syncedAt = null; this.#blockedUntil = 0;
    this.#lastWeight = 0; this.#lastWeightAt = 0; this.#orderTimestamps = [];
    this.#lastAccountSyncAt = null; this.#lastAccountError = null;
  }

  apiKeyTail(length = 4): string | null {
    return this.#apiKey ? this.#apiKey.slice(-Math.max(1, Math.min(12, length))) : null;
  }

  get configured() { return !!this.#apiKey && !!this.#apiSecret && !this.#configurationIssue; }
  get configurationIssue() { return this.#configurationIssue; }
  get blockedUntil() { return this.#blockedUntil; }

  status(): LiveStatus {
    return {
      environment: this.environment, baseUrl: this.baseUrl,
      configured: this.configured, configurationIssue: this.#configurationIssue,
      blockedUntil: this.#blockedUntil, lastWeight: this.#lastWeight,
      ordersThisMinute: this.#countRecentOrders(), lastSyncedAt: this.#syncedAt,
      lastAccountSyncAt: this.#lastAccountSyncAt, lastAccountError: this.#lastAccountError,
    };
  }

  async synchronizeClock() {
    const start = this.#now();
    const data = z.object({ serverTime: z.number().int().positive() }).parse(await this.#public('time'));
    const end = this.#now();
    const roundTripMs = end - start;
    if (roundTripMs < 0 || roundTripMs > 10000) throw new BinanceTradingError('CLOCK_UNSTABLE', '时钟采样期间本机时间跳变或网络往返过慢');
    this.#offset = Math.round(data.serverTime - (start + end) / 2);
    this.#syncedAt = end;
    return { offsetMs: this.#offset, roundTripMs };
  }

  async getAccount(): Promise<FuturesAccount> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    if (this.#syncedAt === null || this.#now() - this.#syncedAt > 60000 || this.#now() < this.#syncedAt) await this.synchronizeClock();
    try {
      const data = await this.#signed('GET', ACCOUNT_PATHS.account, {}, 5);
      const parsed = accountSchema.parse(data);
      this.#lastAccountSyncAt = this.#now();
      this.#lastAccountError = null;
      const positions: FuturesPosition[] = (parsed.positions ?? []).map(p => ({
        symbol: p.symbol, positionSide: p.positionSide ?? 'BOTH', positionAmt: p.positionAmt,
        entryPrice: p.entryPrice ?? '0', markPrice: p.markPrice ?? '0',
        unRealizedProfit: p.unRealizedProfit ?? '0',
        liquidationPrice: p.liquidationPrice ?? '0', leverage: p.leverage ?? '1',
        marginType: p.marginType ?? 'CROSSED',
      }));
      return {
        totalWalletBalance: parsed.totalWalletBalance,
        totalUnrealizedProfit: parsed.totalUnrealizedProfit,
        totalMarginBalance: parsed.totalMarginBalance,
        totalPositionInitialMargin: parsed.totalPositionInitialMargin ?? '0',
        totalOpenOrderInitialMargin: parsed.totalOpenOrderInitialMargin ?? '0',
        availableBalance: parsed.availableBalance ?? '0',
        maxWithdrawAmount: parsed.maxWithdrawAmount ?? '0',
        assets: parsed.assets.map(a => ({
          asset: a.asset,
          walletBalance: a.walletBalance ?? '0', availableBalance: a.availableBalance ?? '0',
          unrealizedProfit: a.unrealizedProfit ?? '0',
          marginBalance: a.marginBalance ?? a.walletBalance ?? '0',
          crossWalletBalance: a.crossWalletBalance ?? a.walletBalance ?? '0',
          crossUnPnl: a.crossUnPnl ?? a.unrealizedProfit ?? '0',
          initialMargin: a.initialMargin ?? '0', maintMargin: a.maintMargin ?? '0',
        })),
        positions,
      };
    } catch (error) {
      if (error instanceof BinanceTradingError) this.#lastAccountError = error.message;
      throw error;
    }
  }

  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbolSchema.parse(symbol);
    const data = await this.#signed('GET', ACCOUNT_PATHS.positions, params, 5);
    return z.array(positionSchema).parse(data).map(p => ({
      symbol: p.symbol, positionSide: p.positionSide, positionAmt: p.positionAmt,
      entryPrice: p.entryPrice, markPrice: p.markPrice, unRealizedProfit: p.unRealizedProfit ?? '0',
      liquidationPrice: p.liquidationPrice, leverage: p.leverage ?? '1', marginType: p.marginType ?? 'CROSSED',
    }));
  }

  async getOpenOrders(symbol?: string): Promise<FuturesOrder[]> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbolSchema.parse(symbol);
    const data = await this.#signed('GET', ACCOUNT_PATHS.openOrders, params, symbol ? 1 : 5);
    return z.array(orderSchema).parse(data).map(this.#normalizeOrder);
  }

  async placeLimitOrder(params: {
    symbol: string; side: 'BUY' | 'SELL'; quantity: string; price: string;
    postOnly?: boolean; reduceOnly?: boolean; clientOrderId?: string;
    workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'; timeInForce?: 'GTC' | 'GTX';
    positionSide?: 'LONG' | 'SHORT';
  }): Promise<FuturesOrder> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    symbolSchema.parse(params.symbol);
    if (!Number.isFinite(Number(params.quantity)) || Number(params.quantity) <= 0) {
      throw new BinanceTradingError('INVALID_QUANTITY', '数量必须为正数');
    }
    if (!Number.isFinite(Number(params.price)) || Number(params.price) <= 0) {
      throw new BinanceTradingError('INVALID_PRICE', '价格必须为正数');
    }
    if (this.#syncedAt === null || this.#now() - this.#syncedAt > 60000) await this.synchronizeClock();
    this.#reserveOrderSlot();
    const body: Record<string, string> = {
      symbol: params.symbol, side: params.side, type: 'LIMIT',
      quantity: params.quantity, price: params.price,
      timeInForce: params.timeInForce ?? (params.postOnly === false ? 'GTC' : 'GTX'),
      newOrderRespType: 'RESULT',
    };
    if (params.reduceOnly && !params.positionSide) body.reduceOnly = 'true';
    if (params.positionSide) body.positionSide = params.positionSide;
    if (params.workingType) body.workingType = params.workingType;
    if (params.clientOrderId) body.newClientOrderId = params.clientOrderId;
    try {
      const data = await this.#signed('POST', TRADING_PATHS.newOrder, body, 1);
      return this.#normalizeOrder(orderSchema.parse(data));
    } catch (error) {
      if (error instanceof BinanceTradingError && error.code === 'TIMESTAMP_REJECTED') {
        await this.synchronizeClock(); this.#reserveOrderSlot();
        const data = await this.#signed('POST', TRADING_PATHS.newOrder, body, 1);
        return this.#normalizeOrder(orderSchema.parse(data));
      }
      throw error;
    }
  }

  async placeMarketOrder(params: {
    symbol: string; side: 'BUY' | 'SELL'; quantity: string; reduceOnly?: boolean;
    clientOrderId?: string;
  }): Promise<FuturesOrder> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    symbolSchema.parse(params.symbol);
    if (!Number.isFinite(Number(params.quantity)) || Number(params.quantity) <= 0) {
      throw new BinanceTradingError('INVALID_QUANTITY', '数量必须为正数');
    }
    if (this.#syncedAt === null || this.#now() - this.#syncedAt > 60000) await this.synchronizeClock();
    this.#reserveOrderSlot();
    const body: Record<string, string> = {
      symbol: params.symbol, side: params.side, type: 'MARKET',
      quantity: params.quantity, newOrderRespType: 'RESULT',
    };
    if (params.reduceOnly) body.reduceOnly = 'true';
    if (params.clientOrderId) body.newClientOrderId = params.clientOrderId;
    try {
      const data = await this.#signed('POST', TRADING_PATHS.newOrder, body, 1);
      return this.#normalizeOrder(orderSchema.parse(data));
    } catch (error) {
      if (error instanceof BinanceTradingError && error.code === 'TIMESTAMP_REJECTED') {
        await this.synchronizeClock(); this.#reserveOrderSlot();
        const data = await this.#signed('POST', TRADING_PATHS.newOrder, body, 1);
        return this.#normalizeOrder(orderSchema.parse(data));
      }
      throw error;
    }
  }

  async cancelOrder(symbol: string, orderId?: string, clientOrderId?: string): Promise<FuturesOrder> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    symbolSchema.parse(symbol);
    if (orderId === undefined && !clientOrderId) throw new BinanceTradingError('INVALID_PARAMS', '撤单时必须提供 orderId 或 clientOrderId');
    const body: Record<string, string> = { symbol };
    if (orderId !== undefined) body.orderId = orderId;
    if (clientOrderId) body.origClientOrderId = clientOrderId;
    const data = await this.#signed('DELETE', TRADING_PATHS.cancelOrder, body, 1);
    return this.#normalizeOrder(orderSchema.parse(data));
  }

  async cancelAllOpenOrders(symbol: string): Promise<{ count: number; orders: FuturesOrder[] }> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    symbolSchema.parse(symbol);
    const data = z.array(orderSchema).parse(await this.#signed('DELETE', TRADING_PATHS.cancelAll, { symbol }, 1));
    return { count: data.length, orders: data.map(this.#normalizeOrder) };
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ symbol: string; leverage: number; maxNotionalValue: string }> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    symbolSchema.parse(symbol);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
      throw new BinanceTradingError('INVALID_LEVERAGE', '杠杆倍数必须是 1-125 的整数');
    }
    const data = z.object({
      symbol: z.string(), leverage: z.number().int(), maxNotionalValue: z.string().or(z.number().transform(String)),
    }).parse(await this.#signed('POST', TRADING_PATHS.setLeverage, { symbol, leverage: String(leverage) }, 1));
    return { symbol: data.symbol, leverage: data.leverage, maxNotionalValue: data.maxNotionalValue };
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    symbolSchema.parse(symbol);
    if (!['ISOLATED', 'CROSSED'].includes(marginType)) {
      throw new BinanceTradingError('INVALID_MARGIN_TYPE', '保证金类型必须是 ISOLATED 或 CROSSED');
    }
    try {
      await this.#signed('POST', TRADING_PATHS.setMarginType, { symbol, marginType }, 1);
    } catch (error) {
      if (error instanceof BinanceTradingError && error.code === 'MARGIN_TYPE_NO_CHANGE') return;
      throw error;
    }
  }

  async getUserTrades(symbol: string, since: number, limit = 100): Promise<UserTrade[]> {
    if (!this.configured) throw new BinanceTradingError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置交易凭据');
    symbolSchema.parse(symbol);
    if (!Number.isInteger(since) || since < 0) throw new BinanceTradingError('INVALID_PARAMS', 'since 必须为非负整数毫秒时间戳');
    const data = z.array(userTradeSchema).parse(await this.#signed('GET', ACCOUNT_PATHS.userTrades, {
      symbol, startTime: String(since), limit: String(Math.min(1000, Math.max(1, limit))),
    }, 5));
    return data.map(trade => ({ ...trade, orderId: trade.orderId !== undefined ? String(trade.orderId) : undefined }));
  }

  #normalizeOrder = (raw: z.infer<typeof orderSchema>): FuturesOrder => ({
    symbol: raw.symbol, orderId: String(raw.orderId), clientOrderId: raw.clientOrderId,
    side: raw.side, type: raw.type, status: raw.status,
    price: raw.price, avgPrice: raw.avgPrice,
    origQty: raw.origQty, executedQty: raw.executedQty, cumQuote: raw.cumQuote,
    timeInForce: raw.timeInForce, reduceOnly: raw.reduceOnly, workingType: raw.workingType,
    updateTime: raw.updateTime, time: raw.time,
  });

  #countRecentOrders(now = this.#now()): number {
    this.#orderTimestamps = this.#orderTimestamps.filter(t => now - t < 60000);
    return this.#orderTimestamps.length;
  }

  #reserveOrderSlot(now = this.#now()): void {
    this.#orderTimestamps = this.#orderTimestamps.filter(t => now - t < 60000);
    this.#orderTimestamps.push(now);
  }

  // 币安订单号是 19 位整数，超过 JS Number 精确范围（2^53），直接 JSON.parse 会丢精度，
  // 导致撤单请求 orderId 错乱。此处先对原始文本做正则处理，把超长整数改写为字符串再解析。
  static #readJson(text: string): unknown {
    const protectedText = text.replace(/([{,]\s*"(?:orderId|tradeId|id)":\s*)(\d{16,})(\s*[,}])/g, '$1"$2"$3');
    return JSON.parse(protectedText);
  }

  async #public(kind: 'time'): Promise<unknown> {
    const path = '/fapi/v1/time';
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.#fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(6000) });
    } catch {
      this.#blockedUntil = this.#now() + 5000;
      throw new BinanceTradingError('NETWORK', '币安连接失败或超时；未自动改换服务器', this.#blockedUntil);
    }
    if (!response.ok) throw new BinanceTradingError('API_REJECTED', `币安接口返回 HTTP ${response.status}`);
    try { return BinanceTradingClient.#readJson(await response.text()); } catch { throw new BinanceTradingError('INVALID_RESPONSE', '币安响应不是有效 JSON'); }
  }

  async #signed(method: 'GET' | 'POST' | 'DELETE', path: string, body: Record<string, string>, weight: number, retried = false): Promise<unknown> {
    const now = this.#now();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null || value === '') continue;
      query.set(key, value);
    }
    const headers: Record<string, string> = { Accept: 'application/json', 'X-MBX-APIKEY': this.#apiKey };
    let url: string;
    let bodyForRequest: string | undefined;
    query.set('recvWindow', '5000'); query.set('timestamp', String(Math.round(now + this.#offset)));
    query.set('signature', createHmac('sha256', this.#apiSecret).update(query.toString()).digest('hex'));
    url = `${this.baseUrl}${path}?${query}`;
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      bodyForRequest = '';
    }
    let response: Response;
    try {
      const init: RequestInit = { method, headers, redirect: 'error', signal: AbortSignal.timeout(8000) };
      if (bodyForRequest !== undefined) init.body = bodyForRequest;
      response = await this.#fetch(url, init);
    } catch {
      this.#blockedUntil = this.#now() + 5000;
      throw new BinanceTradingError('NETWORK', '币安连接失败或超时；未自动改换服务器', this.#blockedUntil);
    }
    const weightHeader = response.headers.get('x-mbx-used-weight-1m');
    if (weightHeader !== null && Number.isFinite(Number(weightHeader))) {
      this.#lastWeight = Math.max(0, Number(weightHeader)); this.#lastWeightAt = this.#now();
    }
    if (response.status === 429 || response.status === 418) {
      const value = response.headers.get('retry-after');
      const numeric = value === null ? NaN : Number(value);
      const retryMs = Number.isFinite(numeric) ? numeric * 1000 : value ? Date.parse(value) - this.#now() : 0;
      this.#blockedUntil = this.#now() + Math.max(response.status === 418 ? 120000 : 60000, Number.isFinite(retryMs) ? retryMs : 0);
      throw new BinanceTradingError('RATE_LIMIT', `币安返回 HTTP ${response.status}，已停止请求并进入退避`, this.#blockedUntil);
    }
    if (response.status === 451) throw new BinanceTradingError('REGION_RESTRICTED', '币安返回 HTTP 451 地区访问限制；该环境尚无法验证');
    if (response.status === 403) throw new BinanceTradingError('ACCESS_DENIED', '币安拒绝访问，请核对账户与网络访问条件');
    if (response.status === 401) throw new BinanceTradingError('AUTH_REJECTED', '账户认证未通过，请检查 Key、环境、读取权限和 IP 限制');
    if (response.status >= 300 && response.status < 400) throw new BinanceTradingError('REDIRECT_REJECTED', '币安返回重定向，未转发账户凭据');
    let data: unknown;
    try { data = BinanceTradingClient.#readJson(await response.text()); } catch { throw new BinanceTradingError('INVALID_RESPONSE', '币安响应不是有效 JSON，操作未采纳'); }
    if (!response.ok) {
      const code = data && typeof data === 'object' && 'code' in data ? Number(data.code) : 0;
      if (code === -1021) {
        // 时钟偏移抖动：校准一次后原样重发（-1021 在服务端处理前即被拒，重发不会重复执行；
        // 且下单均带唯一 newClientOrderId，天然幂等）。GET/DELETE/POST 都安全。
        if (!retried) {
          await this.synchronizeClock();
          return this.#signed(method, path, body, weight, true);
        }
        throw new BinanceTradingError('TIMESTAMP_REJECTED', '请求时间超出接收窗口，时钟校准未通过');
      }
      if (code === -1022) throw new BinanceTradingError('SIGNATURE_REJECTED', '账户签名校验失败，请检查 HMAC Secret');
      if (code === -2015 || code === -2014) throw new BinanceTradingError('AUTH_REJECTED', '账户认证未通过，请检查 Key、环境、读取权限和 IP 限制');
      if (code === -2010) throw new BinanceTradingError('BALANCE_INSUFFICIENT', '账户可用余额不足');
      if (code === -2011) throw new BinanceTradingError('ORDER_REJECTED', '订单被拒：价格、数量或参数无效');
      if (code === -2022) throw new BinanceTradingError('ORDER_REJECTED', '订单被拒（-2022）：只减仓单会使持仓反向增加，或杠杆参数超出允许范围');
      if (code === -4046) throw new BinanceTradingError('MARGIN_TYPE_NO_CHANGE', '保证金类型无需调整');
      throw new BinanceTradingError('API_REJECTED', `币安拒绝（HTTP ${response.status}${Number.isFinite(code) && code ? `，代码 ${code}` : ''}）`);
    }
    return data;
  }
}
