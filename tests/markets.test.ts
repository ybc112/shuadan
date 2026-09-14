import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinancePublicFeed, mergePublicMarkets, parseInstruments } from '../server/markets';

const now = Date.UTC(2026, 8, 10, 12, 0, 0);
const valid = {
  symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC', marginAsset: 'USDC', status: 'TRADING', contractType: 'PERPETUAL',
  filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' }, { filterType: 'MIN_NOTIONAL', notional: '5' }],
};
const book = { symbol: 'BTCUSDC', bidPrice: '79000', askPrice: '79000.1', bidQty: '1', askQty: '1', time: now };
const mark = { symbol: 'BTCUSDC', markPrice: '79000.05', time: now };
const ticker = { symbol: 'BTCUSDC', quoteVolume: '500000000', priceChangePercent: '1.2' };
const instruments = parseInstruments({ symbols: [valid] });

test('ranking universe excludes non-trading, delivery, coin-margin, and missing filters', () => {
  const symbols = [valid, { ...valid, symbol: 'BTCUSD', quoteAsset: 'USD', marginAsset: 'BTC' }, { ...valid, symbol: 'BTCUSDT_260925', contractType: 'CURRENT_QUARTER' }, { ...valid, symbol: 'ETHUSDC', status: 'PENDING_TRADING' }, { ...valid, symbol: 'SOLUSDC', filters: [] }];
  assert.deepEqual(parseInstruments({ symbols }).map(i => i.symbol), ['BTCUSDC']);
  assert.equal(instruments[0].quantityStep, '0.001');
});

test('bad inactive book rows cannot suppress an otherwise valid market', () => {
  const markets = mergePublicMarkets(instruments, [book, { ...book, symbol: 'INVALID', bidPrice: '0' }], [mark], [ticker], [], now);
  assert.equal(markets.length, 1); assert.equal(markets[0].symbol, 'BTCUSDC');
  assert.equal(markets[0].quoteVolume, 500000000);
});

test('exchange timestamps stay stale instead of being replaced with receipt time', () => {
  const markets = mergePublicMarkets(instruments, [{ ...book, time: now - 60000 }], [mark], [ticker], [], now);
  assert.equal(markets[0].updatedAt, now - 60000);
});

test('missing or invalid exchange timestamps cannot borrow freshness from another feed', () => {
  for (const time of [undefined, 0, -1, now + 0.5]) {
    assert.equal(mergePublicMarkets(instruments, [{ ...book, time }], [mark], [ticker], [], now).length, 0);
    assert.equal(mergePublicMarkets(instruments, [book], [{ ...mark, time }], [ticker], [], now).length, 0);
  }
});

test('crossed books, missing marks and far-future exchange clocks are excluded', () => {
  assert.equal(mergePublicMarkets(instruments, [{ ...book, bidPrice: '80000' }], [mark], [ticker], [], now).length, 0);
  assert.equal(mergePublicMarkets(instruments, [book], [], [ticker], [], now).length, 0);
  assert.equal(mergePublicMarkets(instruments, [book], [{ ...mark, time: now + 60000 }], [ticker], [], now).length, 0);
});

test('public API failures are explicit and never fabricate fallback markets', async () => {
  const feed = new BinancePublicFeed(); let calls = 0;
  feed.request = async () => { calls++; throw new Error('HTTP 451'); };
  const result = await feed.poll([], Date.now());
  assert.equal(result, null); assert.equal(feed.status.status, 'error');
  assert.match(feed.status.message, /HTTP 451/);
  assert.ok(!feed.status.message.includes('模拟'), 'must not fake fallback markets');
  await feed.poll([], Date.now()); assert.equal(calls, 1, 'failed reads must back off');
});

test('public feed reads only allowlisted data endpoints and retains a watched contract', async () => {
  const feed = new BinancePublicFeed(); const called: string[] = []; const current = Date.now();
  feed.request = async path => {
    called.push(path);
    if (path.endsWith('exchangeInfo')) return { symbols: [valid] };
    if (path.endsWith('24hr')) return [ticker];
    if (path.endsWith('bookTicker')) return [{ ...book, time: current }];
    if (path.endsWith('premiumIndex')) return [{ ...mark, time: current }];
    throw new Error('Unexpected endpoint');
  };
  const markets = await feed.poll([], current, ['BTCUSDC']);
  assert.equal(markets?.length, 1);
  assert.equal(feed.status.status, 'connected');
  assert.deepEqual(called.sort(), ['/fapi/v1/exchangeInfo', '/fapi/v1/premiumIndex', '/fapi/v1/ticker/24hr', '/fapi/v1/ticker/bookTicker']);
});
