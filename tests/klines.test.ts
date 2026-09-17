import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeKlines, makeBinanceKlinesFetcher, KlineCollector } from '../server/klines';
import type { KlineInterval } from '../server/klines';

// 币安 klines 单行格式： [openTime, open, high, low, close, volume, closeTime, quoteVol, trades]
function row(close: number, open: number, i: number, volume = 100): unknown[] {
  const high = Math.max(open, close) * 1.001;
  const low = Math.min(open, close) * 0.999;
  return [1_700_000_000_000 + i * 60_000, String(open), String(high), String(low), String(close), String(volume), 1_700_000_060_000 + i * 60_000, '0', 1];
}

// 构造 count 根、价格按 base+step*i 走（i 越大价越高）的序列
function series(base: number, step: number, count: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const close = base + step * i;
    const open = i === 0 ? base : base + step * (i - 1);
    out.push(row(close, open, i));
  }
  return out;
}

test('smooth rise -> trend up', () => {
  const s = summarizeKlines('BTCUSDT', '5m', series(100, 0.5, 48), 0)!;
  assert.ok(s);
  assert.equal(s.trend, 1);
  assert.ok(s.changePct > 0);
});

test('narrow oscillation -> trend flat', () => {
  const prices = Array.from({ length: 48 }, (_, i) => 100 + Math.sin(i) * 0.1);
  const s = summarizeKlines('BTCUSDT', '5m', series(100, 0.001, 48), 0)!;
  assert.ok(s);
  assert.equal(s.trend, 0);
});

test('down move -> trend down', () => {
  const s = summarizeKlines('BTCUSDT', '5m', series(100, -0.5, 48), 0)!;
  assert.ok(s);
  assert.equal(s.trend, -1);
});

test('high amplitude captured on big move', () => {
  const flat = summarizeKlines('BTCUSDT', '5m', series(100, 0.001, 48), 0)!;
  const big = summarizeKlines('BTCUSDT', '5m', series(100, 3, 48), 0)!;
  assert.ok(flat && big);
  assert.ok(big.amplitudePct > flat.amplitudePct * 5);
});

test('invalid rows -> null', () => {
  assert.equal(summarizeKlines('BTCUSDT', '5m', [], 0), null);
  assert.equal(summarizeKlines('BTCUSDT', '5m', [1, 2, 3], 0), null);
  assert.equal(summarizeKlines('BTCUSDT', '5m', 'nope' as unknown as unknown[], 0), null);
});

test('collector refreshes and caches per symbol', async () => {
  const calls: string[] = [];
  const fetcher = {
    async fetchKlines(sym: string, interval: KlineInterval) {
      calls.push(`${sym}:${interval}`);
      return series(100, 0.5, 48);
    },
  };
  const collector = new KlineCollector(fetcher as never, { intervals: ['5m', '1d'] });
  await collector.refresh(['BTCUSDT']);
  const snap = collector.snapshot('BTCUSDT');
  assert.equal(snap.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(collector.snapshot('NOPE').length, 0);
});

test('fetcher builds correct URL and parses payload', async () => {
  let seenUrl = '';
  const fetchFn = async (url: string) => {
    seenUrl = String(url);
    return { ok: true, json: async () => series(100, 0.5, 48) };
  };
  const fetcher = makeBinanceKlinesFetcher({ endpoint: 'spot', fetchFn: fetchFn as unknown as typeof fetch });
  const data = await fetcher.fetchKlines('SOLUSDC', '1h', 10);
  assert.ok(data.length >= 4);
  assert.ok(seenUrl.includes('SOLUSDC'));
  assert.ok(seenUrl.includes('interval=1h'));
  assert.ok(seenUrl.includes('limit=10'));
});