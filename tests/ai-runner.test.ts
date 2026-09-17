import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MakerEngine } from '../server/engine';
import { defaultConfig } from '../shared/config';
import { AiRunner } from '../server/ai-runner';
import { KlineCollector } from '../server/klines';
import { NewsCollector } from '../server/info-news';
import { LlmClient } from '../server/llm-client';
import { makeSearchClient } from '../server/web-search';
import type { Market, Robot } from '../shared/types';

function makeMarket(symbol: string, price = 100): Market {
  const now = Date.now();
  return {
    symbol, baseAsset: 'XRP', quoteAsset: 'USDC', priceTick: '0.01', quantityStep: '0.01',
    minQty: '0.01', maxQty: '1000000', minNotional: '5',
    bid: '99.99', ask: '100.01', bidQty: '100', askQty: '100', markPrice: String(price),
    changePercent: 0, quoteVolume: 0, updatedAt: now,
    history: [{ time: now - 9000, price }, { time: now, price }],
  };
}

function rows(count: number, base = 100): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const close = base + i * 0.05;
    const open = i === 0 ? base : base + (i - 1) * 0.05;
    out.push([1_700_000_000_000 + i * 60_000, String(open), String(close * 1.001), String(close * 0.999), String(close), '100', 1_700_000_060_000 + i * 60_000, '0', 1]);
  }
  return out;
}

function makeEngine(): MakerEngine {
  const engine = new MakerEngine(undefined, Date.now());
  engine.robots = [];
  engine.wallets = { USDC: '10000', USDT: '10000' };
  engine.dailyStartEquity = '20000'; engine.peakEquity = '20000';
  engine.acceptMarkets([makeMarket('XRPUSDC')], Date.now());
  return engine;
}

function addRobot(engine: MakerEngine): Robot {
  return engine.addRobot({
    ...defaultConfig(engine.market('XRPUSDC')),
    gridCount: 4, rangeMode: 'fixed', halfRange: 1, orderSize: 100,
    maxOrderNotional: 200, repriceSeconds: 5, shockPercent: 5, cooldownSeconds: 10,
  }, Date.now()) as Robot;
}

function makeRunner(engine: MakerEngine, fetchFn: typeof fetch): AiRunner {
  const klines = new KlineCollector({ fetchKlines: async () => rows(48) } as never, { intervals: ['5m'] });
  const news = new NewsCollector({ fetchAnnouncements: async () => ({ code: '000000', data: { articles: [] } }) } as never);
  const llm = LlmClient.fromEnv({ ...process.env, LLM_API_KEY: 'test' } as never, { fetchFn });
  return new AiRunner({
    engine, klines, news, llm,
    search: makeSearchClient({ SEARCH_PROVIDER: 'none' } as never),
    dataDir: process.env.TEMP || '/tmp', intervalMinutes: 1, enabled: true, searchProvider: 'none',
  });
}

function llmFetchReturning(body: string) {
  return async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: body } }] }) }) as never;
}

test('AiRunner applies validated suggestion via applyLiveParams while running', async () => {
  const engine = makeEngine();
  const robot = addRobot(engine);
  engine.startRobot(robot.id, Date.now());
  assert.equal(robot.status, 'running');
  const before = robot.halfRange;

  const runner = makeRunner(engine, llmFetchReturning(JSON.stringify({
    symbol: 'XRPUSDC', adjustments: { halfRange: 1.5 }, reason: '波动加大放宽区间',
  })));
  await runner.runOnce();
  assert.equal(robot.halfRange, 1.5);
  assert.equal(robot.status, 'running');
  assert.ok(engine.orders.length > 0, 'should re-quote after hot update');
  assert.notEqual(before, robot.halfRange);
});

test('AiRunner rejects blacklist change and leaves robot untouched', async () => {
  const engine = makeEngine();
  const robot = addRobot(engine);
  engine.startRobot(robot.id, Date.now());
  const before = robot.leverage;

  const runner = makeRunner(engine, llmFetchReturning(JSON.stringify({
    symbol: 'XRPUSDC', adjustments: { leverage: 99 }, reason: '想加杠杆',
  })));
  await runner.runOnce();
  assert.equal(robot.leverage, before, 'leverage must not change');
  assert.ok(engine.orders.length > 0, 'robot continues trading untouched');
});