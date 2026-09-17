import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnouncements, makeBinanceNewsFetcher, NewsCollector } from '../server/info-news';

test('parse valid announcement payload', () => {
  const payload = {
    code: '000000',
    data: { articles: [
      { id: 284660, title: 'Binance Will Add bStocks Collateral - 2026-09-16' },
      { id: 284643, title: 'Binance Exchange Adds GoPro and Reddit bStocks Pairs' },
    ] },
  };
  const items = parseAnnouncements(payload);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 284660);
  assert.ok(items[0].title.includes('bStocks'));
});

test('parse invalid payload -> empty', () => {
  assert.deepEqual(parseAnnouncements({ code: '999999' }), []);
  assert.deepEqual(parseAnnouncements(null), []);
  assert.deepEqual(parseAnnouncements({ data: { articles: 'x' } }), []);
  assert.deepEqual(parseAnnouncements({ data: { articles: [{ id: 1 }] } }), []);
});

test('filter empty titles', () => {
  const items = parseAnnouncements({ code: '000000', data: { articles: [
    { id: 1, title: '  ' },
    { id: 2, title: 'real title' },
  ] } });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 2);
});

test('collector keeps old cache on fetch failure', async () => {
  let calls = 0;
  const fetcher = {
    async fetchAnnouncements() { calls += 1; throw new Error('boom'); },
  };
  const collector = new NewsCollector(fetcher as never);
  await collector.refresh();
  assert.deepEqual(collector.snapshot(), []);
  assert.equal(calls, 1);
});