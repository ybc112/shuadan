import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BinanceReadError, BinanceReadOnlyClient, readOnlyConfigFromEnv, type AccountRead, type PublicRead } from '../server/binance-readonly';
import { ConnectionInspector } from '../server/connection-inspector';

const NOW = Date.UTC(2026, 8, 11, 1);
const KEY = 'fixture-read-key-not-a-real-key';
const SECRET = 'fixture-secret-not-a-real-secret';
const ACCOUNT_PATHS = ['/fapi/v3/account', '/fapi/v3/positionRisk', '/fapi/v1/positionSide/dual', '/fapi/v1/multiAssetsMargin', '/fapi/v1/commissionRate'];
const PUBLIC_PATHS = ['/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/ticker/bookTicker', '/fapi/v1/premiumIndex', '/fapi/v1/ticker/24hr'];
const instrument = {
  symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL',
  filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' }, { filterType: 'MIN_NOTIONAL', notional: '5' }],
};
const position = { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.01', entryPrice: '79000', markPrice: '79010', liquidationPrice: '60000' };

function payload(path: string, now: number): unknown {
  switch (path) {
    case '/fapi/v1/time': return { serverTime: now };
    case '/fapi/v1/exchangeInfo': return { symbols: [instrument] };
    case '/fapi/v1/ticker/bookTicker': return { symbol: 'BTCUSDT', bidPrice: '79000', askPrice: '79000.1', bidQty: '1', askQty: '1', time: now };
    case '/fapi/v1/premiumIndex': return { symbol: 'BTCUSDT', markPrice: '79000.05', time: now };
    case '/fapi/v1/ticker/24hr': return [];
    case '/fapi/v3/account': return { assets: ['USDT', 'USDC', 'BNB'].map(asset => ({ asset, walletBalance: '1000.12345678', availableBalance: '800.12345678', unrealizedProfit: '-2.12345678' })) };
    case '/fapi/v3/positionRisk': return [{ ...position, positionAmt: '0' }];
    case '/fapi/v1/positionSide/dual': return { dualSidePosition: false };
    case '/fapi/v1/multiAssetsMargin': return { multiAssetsMargin: false };
    case '/fapi/v1/commissionRate': return { symbol: 'BTCUSDT', makerCommissionRate: '0.0002', takerCommissionRate: '0.0005' };
    default: throw new Error('Unexpected fixture path');
  }
}

interface CapturedRequest { url: URL; init: RequestInit; headers: Headers }
function harness(options: { keys?: boolean; environment?: 'demo' | 'production'; respond?: (request: CapturedRequest, current: number) => Response | undefined | Promise<Response | undefined> } = {}) {
  let current = NOW;
  const requests: CapturedRequest[] = [];
  const transport = (async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const request = { url, init, headers: new Headers(init.headers) };
    requests.push(request);
    return await options.respond?.(request, current) ?? Response.json(payload(url.pathname, current));
  }) as typeof fetch;
  const client = new BinanceReadOnlyClient({ environment: options.environment ?? 'demo', apiKey: options.keys ? KEY : '', apiSecret: options.keys ? SECRET : '' }, { fetch: transport, now: () => current });
  const inspector = new ConnectionInspector(client, () => current);
  return { client, inspector, requests, now: () => current, advance: (ms: number) => { current += ms; } };
}

async function rejectsCode(operation: Promise<unknown>, expected: string) {
  await assert.rejects(operation, error => {
    assert(error instanceof BinanceReadError);
    assert.equal(error.code, expected);
    assert(!error.message.includes(KEY)); assert(!error.message.includes(SECRET));
    assert(!error.message.includes('signature=')); assert(!error.message.includes('untrusted-response-message'));
    return true;
  });
}
function verifySignature(request: CapturedRequest) {
  const query = new URLSearchParams(request.url.search);
  const signature = query.get('signature'); query.delete('signature');
  assert.equal(signature, createHmac('sha256', SECRET).update(query.toString()).digest('hex'));
  assert.equal(request.headers.get('X-MBX-APIKEY'), KEY);
  assert.equal(query.get('recvWindow'), '5000');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.redirect, 'error');
  assert(request.init.signal instanceof AbortSignal);
}
const check = (h: ReturnType<typeof harness>, id: string) => h.inspector.status().lastReport?.checks.find(item => item.id === id);

test('configuration defaults to Demo and ignores generic trading credential variables', () => {
  assert.deepEqual(readOnlyConfigFromEnv({ BINANCE_API_KEY: KEY, BINANCE_API_SECRET: SECRET }), { environment: 'demo', apiKey: undefined, apiSecret: undefined });
  assert.equal(readOnlyConfigFromEnv({ BINANCE_READONLY_ENV: 'production' }).environment, 'production');
  assert.throws(() => readOnlyConfigFromEnv({ BINANCE_READONLY_ENV: SECRET }), error => error instanceof BinanceReadError && error.code === 'ENVIRONMENT_INVALID' && !error.message.includes(SECRET));
  for (const config of [{ apiKey: KEY }, { apiSecret: SECRET }, { apiKey: 'short', apiSecret: SECRET }, { apiKey: KEY, apiSecret: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----' }]) {
    const client = new BinanceReadOnlyClient({ environment: 'demo', ...config });
    assert.equal(client.configured, false); assert(client.configurationIssue);
    assert(!JSON.stringify(client).includes(KEY)); assert(!JSON.stringify(client).includes(SECRET));
  }
});

test('public queries use fixed environment origins and never attach credentials', async () => {
  for (const environment of ['demo', 'production'] as const) {
    const h = harness({ keys: true, environment });
    for (const kind of ['time', 'exchangeInfo', 'bookTicker', 'premiumIndex', 'ticker24h'] as const) await h.client.publicData(kind);
    for (const request of h.requests) {
      assert.equal(request.url.origin, environment === 'demo' ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com');
      assert(PUBLIC_PATHS.includes(request.url.pathname)); assert.equal(request.init.method, 'GET');
      assert.equal(request.headers.get('X-MBX-APIKEY'), null); assert.equal(request.url.search, '');
      assert.equal(request.init.redirect, 'error');
    }
  }
});

test('unknown paths, inherited object keys, bad symbols and unsupported arguments never reach fetch', async () => {
  const h = harness({ keys: true });
  for (const path of ['https://untrusted.example', '/fapi/v1/order', '__proto__', 'toString']) {
    await rejectsCode(h.client.publicData(path as PublicRead), 'PATH_NOT_ALLOWED');
    await rejectsCode(h.client.accountData(path as AccountRead), 'PATH_NOT_ALLOWED');
  }
  await rejectsCode(h.client.publicData('time', 'BTCUSDT'), 'INVALID_PARAMS');
  await rejectsCode(h.client.accountData('account', 'BTCUSDT'), 'INVALID_PARAMS');
  await assert.rejects(h.client.publicData('bookTicker', 'BTCUSDT&symbol=ETHUSDT'));
  await assert.rejects(h.client.accountData('commission'));
  assert.equal(h.requests.length, 0);
  const missing = harness(); await rejectsCode(missing.client.accountData('account'), 'CREDENTIALS_MISSING');
  assert.equal(missing.requests.length, 0);
});

test('signed queries use HMAC over exact encoded parameters and midpoint-calibrated timestamps', async () => {
  const h = harness({ keys: true, respond: ({ url }) => {
    if (url.pathname === '/fapi/v1/time') { h.advance(40); return Response.json({ serverTime: NOW + 1020 }); }
  } });
  await h.client.accountData('commission', 'BTCUSDT');
  assert.equal(h.requests.length, 2);
  verifySignature(h.requests[1]);
  assert.equal(h.requests[1].url.searchParams.get('symbol'), 'BTCUSDT');
  assert.equal(h.requests[1].url.searchParams.get('timestamp'), String(NOW + 1040));
  assert.equal(h.requests[0].headers.get('X-MBX-APIKEY'), null);
});

test('clock calibration is reused briefly and refreshed after expiry or a backwards clock jump', async () => {
  const h = harness({ keys: true });
  await h.client.accountData('account'); h.advance(1000); await h.client.accountData('account');
  h.advance(60001); await h.client.accountData('account');
  h.advance(-100); await h.client.accountData('account');
  assert.equal(h.requests.filter(r => r.url.pathname === '/fapi/v1/time').length, 3);
  assert.equal(h.requests.filter(r => r.url.pathname === '/fapi/v3/account').length, 4);
});

test('a timestamp rejection resynchronizes once, then returns the successful signed query', async () => {
  let attempts = 0;
  const h = harness({ keys: true, respond: ({ url }) => {
    if (url.pathname === '/fapi/v3/account' && ++attempts === 1) return Response.json({ code: -1021 }, { status: 400 });
  } });
  await h.client.accountData('account');
  assert.equal(attempts, 2);
  assert.equal(h.requests.filter(r => r.url.pathname === '/fapi/v1/time').length, 2);
  h.requests.filter(r => ACCOUNT_PATHS.includes(r.url.pathname)).forEach(verifySignature);
});

test('persistent timestamp rejection is bounded to two signed requests', async () => {
  const h = harness({ keys: true, respond: ({ url }) => url.pathname === '/fapi/v3/account' ? Response.json({ code: -1021 }, { status: 400 }) : undefined });
  await rejectsCode(h.client.accountData('account'), 'TIMESTAMP_REJECTED');
  assert.equal(h.requests.length, 4);
});

for (const [code, expected] of [[-1022, 'SIGNATURE_REJECTED'], [-2015, 'AUTH_REJECTED'], [-2014, 'AUTH_REJECTED'], [-1000, 'API_REJECTED']] as const) {
  test(`API rejection ${code} does not retry or reflect the exchange error message`, async () => {
    const h = harness({ keys: true, respond: ({ url }) => url.pathname === '/fapi/v3/account' ? Response.json({ code, msg: `untrusted-response-message ${KEY} ${SECRET} ${url}` }, { status: 400 }) : undefined });
    await rejectsCode(h.client.accountData('account'), expected);
    assert.equal(h.requests.length, 2);
  });
}

test('transport errors cannot leak signed URLs or credentials and cause a short backoff', async () => {
  const h = harness({ keys: true, respond: ({ url }) => {
    if (url.pathname === '/fapi/v3/account') throw new Error(`untrusted-response-message ${KEY} ${SECRET} ${url}`);
    return undefined;
  } });
  await rejectsCode(h.client.accountData('account'), 'NETWORK');
  assert.equal(h.client.blockedUntil, NOW + 5000);
  // 已移除“提前退避”：退避只记录，不拦截后续请求（用户要求仅保留真实 429/418 处理）
  await h.client.publicData('time');
  assert.equal(h.requests.length, 3);
});

for (const [status, expected] of [[302, 'REDIRECT_REJECTED'], [401, 'AUTH_REJECTED'], [403, 'ACCESS_DENIED'], [451, 'REGION_RESTRICTED']] as const) {
  test(`HTTP ${status} is classified without following redirects or exposing the response body`, async () => {
    const h = harness({ keys: true, respond: ({ url }) => url.pathname === '/fapi/v3/account' ? new Response(`untrusted-response-message ${SECRET}`, { status, headers: { Location: 'https://untrusted.example' } }) : undefined });
    await rejectsCode(h.client.accountData('account'), expected); assert.equal(h.requests.length, 2);
  });
}

for (const scenario of [{ status: 429, retry: '90', wait: 90000 }, { status: 418, retry: '1', wait: 120000 }, { status: 429, retry: new Date(NOW + 180000).toUTCString(), wait: 180000 }]) {
  test(`HTTP ${scenario.status} honors retry-after ${scenario.retry}; 退避只记录、不拦截后续请求`, async () => {
    let first = true;
    const h = harness({ respond: () => {
      if (first) { first = false; return new Response('', { status: scenario.status, headers: { 'retry-after': scenario.retry } }); }
    } });
    await rejectsCode(h.client.publicData('time'), 'RATE_LIMIT');
    assert.equal(h.client.blockedUntil, NOW + scenario.wait);
    // 不再提前退避：窗口内的下一次请求照发，是否被拒由交易所真实响应决定
    await h.client.publicData('time');
    assert.equal(h.requests.length, 2);
  });
}

test('high request weight is recorded for monitoring but no longer reserves headroom', async () => {
  let first = true;
  const h = harness({ respond: () => {
    if (first) { first = false; return Response.json({ serverTime: NOW }, { headers: { 'x-mbx-used-weight-1m': '1800' } }); }
  } });
  await h.client.publicData('time');
  await h.client.publicData('exchangeInfo');
  assert.equal(h.requests.length, 2);
});

test('malformed JSON and an unstable clock fail before any authenticated request', async () => {
  const malformed = harness({ keys: true, respond: () => new Response(`untrusted-response-message ${SECRET}`, { status: 200 }) });
  await rejectsCode(malformed.client.accountData('account'), 'INVALID_RESPONSE');
  assert.equal(malformed.requests.length, 1);
  const slow = harness({ keys: true, respond: () => { slow.advance(10001); return Response.json({ serverTime: NOW }); } });
  await rejectsCode(slow.client.accountData('account'), 'CLOCK_UNSTABLE'); assert.equal(slow.requests.length, 1);
});

test('public inspection with configured keys does not read an account without opt-in', async () => {
  const h = harness({ keys: true }); h.inspector.start('BTCUSDT', false);
  const status = await h.inspector.waitForCompletion();
  assert.equal(status.running, false); assert.equal(status.lastReport?.publicDataVerified, true);
  assert.equal(status.lastReport?.accountReadVerified, false); assert.equal(status.lastReport?.account, undefined);
  assert.equal(status.lastReport?.liveTradingAvailable, false); assert.equal(status.execution, 'read-only');
  assert.equal(check(h, 'execution')?.status, 'not_implemented'); assert.equal(check(h, 'account')?.status, 'skipped');
  assert(h.requests.every(r => PUBLIC_PATHS.includes(r.url.pathname) && !r.headers.has('X-MBX-APIKEY')));
});

test('a requested account check without keys is skipped explicitly after public checks', async () => {
  const h = harness(); h.inspector.start('BTCUSDT', true); await h.inspector.waitForCompletion();
  assert.equal(check(h, 'account')?.status, 'skipped'); assert.equal(check(h, 'positions')?.status, 'skipped');
  assert.equal(h.requests.length, 4);
});

test('a fully successful authenticated read preserves decimal balances and still cannot trade', async () => {
  const h = harness({ keys: true }); h.inspector.start('BTCUSDT', true);
  const status = await h.inspector.waitForCompletion(); const report = status.lastReport!;
  assert.equal(report.accountReadVerified, true); assert.equal(report.publicDataVerified, true);
  assert.equal(report.liveTradingAvailable, false); assert(report.finishedAt);
  assert(report.checks.filter(c => c.id !== 'execution').every(c => c.status === 'passed'));
  assert.deepEqual(report.account?.assets.map(asset => asset.asset), ['USDT', 'USDC']);
  assert.equal(report.account?.assets[0].walletBalance, '1000.12345678');
  assert.equal(report.account?.assets[0].unrealizedProfit, '-2.12345678');
  assert.deepEqual(report.account?.positions, []); assert.equal(report.account?.makerFeeRate, '0.0002');
  assert.equal(report.account?.takerFeeRate, '0.0005');
  assert.equal(h.requests.length, 9);
  for (const request of h.requests) {
    assert.equal(request.init.method, 'GET');
    if (ACCOUNT_PATHS.includes(request.url.pathname)) verifySignature(request);
    else { assert(PUBLIC_PATHS.includes(request.url.pathname)); assert(!request.headers.has('X-MBX-APIKEY')); }
  }
  assert(!JSON.stringify(status).includes(KEY)); assert(!JSON.stringify(status).includes(SECRET));
});

test('hedge mode, multi-asset margin and existing positions are reported without modifying the account', async () => {
  const h = harness({ keys: true, respond: ({ url }) => {
    if (url.pathname.endsWith('/positionSide/dual')) return Response.json({ dualSidePosition: true });
    if (url.pathname.endsWith('/multiAssetsMargin')) return Response.json({ multiAssetsMargin: true });
    if (url.pathname.endsWith('/positionRisk')) return Response.json([{ ...position, positionSide: 'LONG' }, { ...position, positionSide: 'SHORT', positionAmt: '-0.002' }, { ...position, symbol: 'ETHUSDT', positionAmt: '0' }]);
  } });
  h.inspector.start('BTCUSDT', true); const status = await h.inspector.waitForCompletion();
  for (const id of ['positionMode', 'marginMode', 'positions']) assert.equal(check(h, id)?.status, 'warning');
  assert.equal(status.lastReport?.account?.positions?.length, 2);
  assert.equal(status.lastReport?.account?.positions?.[1].quantity, '-0.002');
  assert(h.requests.every(request => request.init.method === 'GET'));
});

test('region restriction stops the check before credentials are sent', async () => {
  const h = harness({ keys: true, respond: () => new Response('', { status: 451 }) });
  h.inspector.start('BTCUSDT', true); const status = await h.inspector.waitForCompletion();
  assert.equal(h.requests.length, 1); assert(!h.requests[0].headers.has('X-MBX-APIKEY'));
  assert.equal(status.lastReport?.publicDataVerified, false); assert.equal(status.lastReport?.accountReadVerified, false);
  assert.equal(check(h, 'clock')?.status, 'failed'); assert.match(check(h, 'clock')!.detail, /451/);
  for (const id of ['instrument', 'market', 'account', 'positions']) assert.equal(check(h, id)?.status, 'skipped');
});

test('an unavailable contract cannot produce verified market data or a fee query', async () => {
  const h = harness({ keys: true }); h.inspector.start('ETHUSDT', true); await h.inspector.waitForCompletion();
  assert.equal(check(h, 'instrument')?.status, 'failed'); assert.equal(check(h, 'market')?.status, 'skipped');
  assert.equal(check(h, 'fees')?.status, 'skipped'); assert.equal(h.inspector.status().lastReport?.publicDataVerified, false);
  assert(!h.requests.some(r => r.url.pathname.includes('commissionRate') || r.url.pathname.includes('bookTicker')));
});

for (const scenario of [
  { name: 'stale book', kind: 'bookTicker', change: { time: NOW - 8001 } },
  { name: 'future book', kind: 'bookTicker', change: { time: NOW + 1001 } },
  { name: 'future mark beside current book', kind: 'premiumIndex', change: { time: NOW + 1001 } },
  { name: 'missing book timestamp', kind: 'bookTicker', change: { time: undefined } },
  { name: 'crossed book', kind: 'bookTicker', change: { askPrice: '78000' } },
  { name: 'wrong symbol', kind: 'premiumIndex', change: { symbol: 'ETHUSDT' } },
  { name: 'nonfinite mark', kind: 'premiumIndex', change: { markPrice: 'Infinity' } },
]) {
  test(`inspection rejects ${scenario.name} without accepting a market snapshot`, async () => {
    const h = harness({ respond: ({ url }, current) => url.pathname.endsWith(scenario.kind) ? Response.json({ ...payload(url.pathname, current) as object, ...scenario.change }) : undefined });
    h.inspector.start('BTCUSDT', false); const status = await h.inspector.waitForCompletion();
    assert.equal(check(h, 'market')?.status, 'failed'); assert.equal(status.lastReport?.publicDataVerified, false);
  });
}

test('authentication failures are distinct from public connectivity and never trigger more private queries', async () => {
  const h = harness({ keys: true, respond: ({ url }) => url.pathname.endsWith('/account') ? Response.json({ code: -2015, msg: `untrusted-response-message ${SECRET}` }, { status: 400 }) : undefined });
  h.inspector.start('BTCUSDT', true); const status = await h.inspector.waitForCompletion();
  assert.equal(status.lastReport?.publicDataVerified, true); assert.equal(status.lastReport?.accountReadVerified, false);
  assert.equal(check(h, 'account')?.status, 'failed'); assert.equal(check(h, 'fees')?.status, 'skipped');
  assert.equal(h.requests.filter(r => r.headers.has('X-MBX-APIKEY')).length, 1);
  assert(!JSON.stringify(status).includes(SECRET));
});

test('malformed account subqueries stay failed instead of being inferred from a successful balance read', async () => {
  const h = harness({ keys: true, respond: ({ url }) => {
    if (url.pathname.endsWith('/positionSide/dual')) return Response.json({ dualSidePosition: 'false' });
    if (url.pathname.endsWith('/positionRisk')) return Response.json([{ ...position, positionAmt: 'NaN' }]);
    if (url.pathname.endsWith('/commissionRate')) return Response.json({ symbol: 'ETHUSDT', makerCommissionRate: '0.0002', takerCommissionRate: '0.0005' });
  } });
  h.inspector.start('BTCUSDT', true); const status = await h.inspector.waitForCompletion();
  assert.equal(status.lastReport?.accountReadVerified, true);
  for (const id of ['positionMode', 'positions', 'fees']) assert.equal(check(h, id)?.status, 'failed');
  assert.equal(status.lastReport?.account?.hedgeMode, undefined); assert.equal(status.lastReport?.account?.positions, undefined);
  assert.equal(status.lastReport?.account?.makerFeeRate, undefined); assert.equal(status.lastReport?.liveTradingAvailable, false);
});

test('inspection prevents overlapping jobs, enforces cooldown and can run again afterward', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ respond: async ({ url }) => { if (url.pathname.endsWith('/time')) await gate; return undefined; } });
  assert.throws(() => h.inspector.start('../order', false)); assert.equal(h.requests.length, 0);
  const first = h.inspector.start('BTCUSDT', false); assert.equal(first.running, true);
  assert.throws(() => h.inspector.start('BTCUSDT', false), /正在进行/);
  release(); await h.inspector.waitForCompletion();
  assert.throws(() => h.inspector.start('BTCUSDT', false), /稍后再试/);
  h.advance(30000); const second = h.inspector.start('BTCUSDT', false); assert.notEqual(second.lastReport?.id, first.lastReport?.id);
  await h.inspector.waitForCompletion(); assert.equal(h.requests.length, 8);
});

test('inspection exposes exchange backoff instead of retrying at its normal 30-second interval', async () => {
  const h = harness({ respond: () => new Response('', { status: 429, headers: { 'retry-after': '120' } }) });
  h.inspector.start('BTCUSDT', false); await h.inspector.waitForCompletion();
  assert.equal(h.inspector.status().nextCheckAt, NOW + 120000);
  h.advance(30000); assert.throws(() => h.inspector.start('BTCUSDT', false), /稍后再试/);
  assert.equal(h.requests.length, 1);
});
