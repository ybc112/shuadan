import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { BinanceEnvironment } from '../shared/connection';

const ORIGINS: Record<BinanceEnvironment, string> = Object.freeze({
  demo: 'https://demo-fapi.binance.com',
  production: 'https://fapi.binance.com',
});
const PUBLIC_PATHS = Object.freeze({
  time: '/fapi/v1/time', exchangeInfo: '/fapi/v1/exchangeInfo',
  bookTicker: '/fapi/v1/ticker/bookTicker', premiumIndex: '/fapi/v1/premiumIndex',
  ticker24h: '/fapi/v1/ticker/24hr',
});
const ACCOUNT_PATHS = Object.freeze({
  account: '/fapi/v3/account', positions: '/fapi/v3/positionRisk',
  positionMode: '/fapi/v1/positionSide/dual', multiAssets: '/fapi/v1/multiAssetsMargin',
  commission: '/fapi/v1/commissionRate',
});
export type PublicRead = keyof typeof PUBLIC_PATHS;
export type AccountRead = keyof typeof ACCOUNT_PATHS;
export const symbolSchema = z.string().regex(/^[A-Z0-9]{3,30}$/, '请输入有效的合约代码');

export class BinanceReadError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryAt = 0) {
    super(message); this.name = 'BinanceReadError';
  }
}

export interface ReadOnlyConfig {
  environment: BinanceEnvironment;
  apiKey?: string;
  apiSecret?: string;
}

export function readOnlyConfigFromEnv(env: NodeJS.ProcessEnv): ReadOnlyConfig {
  const parsed = z.enum(['demo', 'production']).safeParse(env.BINANCE_READONLY_ENV ?? 'demo');
  if (!parsed.success) throw new BinanceReadError('ENVIRONMENT_INVALID', 'BINANCE_READONLY_ENV 只能为 demo 或 production');
  const environment = parsed.data;
  return { environment, apiKey: env.BINANCE_READONLY_API_KEY, apiSecret: env.BINANCE_READONLY_API_SECRET };
}

// Read-only transport. Node's fetch is injected in tests, never exposed to the UI.
// Neither this class nor any caller offers an order/margin/leverage mutation path.
export class BinanceReadOnlyClient {
  readonly environment: BinanceEnvironment;
  readonly baseUrl: string;
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

  constructor(config: ReadOnlyConfig, dependencies: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.environment = z.enum(['demo', 'production']).parse(config.environment);
    this.baseUrl = ORIGINS[this.environment];
    this.#apiKey = config.apiKey?.trim() ?? '';
    this.#apiSecret = config.apiSecret?.trim() ?? '';
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? Date.now;
    if (!!this.#apiKey !== !!this.#apiSecret) this.#configurationIssue = 'API Key 与 Secret 必须同时配置';
    else if (this.#apiKey && (!/^[!-~]{16,256}$/.test(this.#apiKey) || !/^[!-~]{16,512}$/.test(this.#apiSecret))) {
      this.#configurationIssue = '凭据格式无效；此连接器仅支持 HMAC Key / Secret，不支持 PEM 私钥';
    }
  }

  get configured() { return !!this.#apiKey && !!this.#apiSecret && !this.#configurationIssue; }
  get configurationIssue() { return this.#configurationIssue; }
  get blockedUntil() { return this.#blockedUntil; }

  async publicData(kind: PublicRead, symbol?: string): Promise<unknown> {
    if (!Object.hasOwn(PUBLIC_PATHS, kind)) throw new BinanceReadError('PATH_NOT_ALLOWED', '未允许的公开查询');
    const params: Record<string, string> = {};
    if (symbol !== undefined) {
      if (!['bookTicker', 'premiumIndex', 'ticker24h'].includes(kind)) throw new BinanceReadError('INVALID_PARAMS', '此查询不接受合约参数');
      params.symbol = symbolSchema.parse(symbol);
    }
    return this.#request(PUBLIC_PATHS[kind], params, false);
  }

  async synchronizeClock() {
    const start = this.#now();
    const data = z.object({ serverTime: z.number().int().positive() }).parse(await this.publicData('time'));
    const end = this.#now();
    const roundTripMs = end - start;
    if (roundTripMs < 0 || roundTripMs > 10000) throw new BinanceReadError('CLOCK_UNSTABLE', '时钟采样期间本机时间跳变或网络往返过慢');
    this.#offset = Math.round(data.serverTime - (start + end) / 2);
    this.#syncedAt = end;
    return { offsetMs: this.#offset, roundTripMs };
  }

  async accountData(kind: AccountRead, symbol?: string): Promise<unknown> {
    if (!Object.hasOwn(ACCOUNT_PATHS, kind)) throw new BinanceReadError('PATH_NOT_ALLOWED', '未允许的账户查询');
    if (!this.configured) throw new BinanceReadError('CREDENTIALS_MISSING', this.#configurationIssue ?? '尚未配置只读账户凭据');
    const params: Record<string, string> = {};
    if (kind === 'commission') params.symbol = symbolSchema.parse(symbol);
    else if (symbol !== undefined) throw new BinanceReadError('INVALID_PARAMS', '此账户查询不接受合约参数');
    if (this.#syncedAt === null || this.#now() - this.#syncedAt > 60000 || this.#now() < this.#syncedAt) await this.synchronizeClock();
    try { return await this.#request(ACCOUNT_PATHS[kind], params, true); }
    catch (error) {
      // One bounded resync is safe for GET queries. Never loop on bad keys or limits.
      if (!(error instanceof BinanceReadError) || error.code !== 'TIMESTAMP_REJECTED') throw error;
      await this.synchronizeClock();
      return this.#request(ACCOUNT_PATHS[kind], params, true);
    }
  }

  async #request(path: string, params: Record<string, string>, signed: boolean): Promise<unknown> {
    const now = this.#now();
    const query = new URLSearchParams(params);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (signed) {
      query.set('recvWindow', '5000');
      query.set('timestamp', String(Math.round(this.#now() + this.#offset)));
      query.set('signature', createHmac('sha256', this.#apiSecret).update(query.toString()).digest('hex'));
      headers['X-MBX-APIKEY'] = this.#apiKey;
    }
    const url = `${this.baseUrl}${path}${query.size ? `?${query}` : ''}`;
    let response: Response;
    try {
      response = await this.#fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(6000) });
    } catch {
      this.#blockedUntil = this.#now() + 5000;
      // Do not propagate fetch exception strings: signed URLs or credentials may be present.
      throw new BinanceReadError('NETWORK', '币安连接失败、超时或返回重定向；未自动改换服务器', this.#blockedUntil);
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
      throw new BinanceReadError('RATE_LIMIT', `币安返回 HTTP ${response.status}，已停止请求并进入退避`, this.#blockedUntil);
    }
    if (response.status === 451) throw new BinanceReadError('REGION_RESTRICTED', '币安返回 HTTP 451 地区访问限制；该环境尚无法验证');
    if (response.status === 403) throw new BinanceReadError('ACCESS_DENIED', '币安拒绝访问，请核对账户与网络访问条件');
    if (response.status === 401) throw new BinanceReadError('AUTH_REJECTED', '账户认证未通过，请检查 Key、环境、读取权限和 IP 限制');
    if (response.status >= 300 && response.status < 400) throw new BinanceReadError('REDIRECT_REJECTED', '币安返回重定向，未转发账户凭据');
    let data: unknown;
    try { data = await response.json(); } catch { throw new BinanceReadError('INVALID_RESPONSE', '币安响应不是有效 JSON，查询结果未采纳'); }
    const code = data && typeof data === 'object' && 'code' in data ? Number(data.code) : 0;
    if (!response.ok || code < 0) {
      if (code === -1021) throw new BinanceReadError('TIMESTAMP_REJECTED', '请求时间超出接收窗口，时钟校准未通过');
      if (code === -1022) throw new BinanceReadError('SIGNATURE_REJECTED', '账户签名校验失败，请检查 HMAC Secret');
      if (code === -2015 || code === -2014) throw new BinanceReadError('AUTH_REJECTED', '账户认证未通过，请检查 Key、环境、读取权限和 IP 限制');
      throw new BinanceReadError('API_REJECTED', `币安查询失败（HTTP ${response.status}${Number.isFinite(code) && code ? `，代码 ${code}` : ''}）`);
    }
    return data;
  }
}
