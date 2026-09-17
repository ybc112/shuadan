import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_ALLOWED_FIELDS,
  guardAiAdjustment,
  buildAiPrompt,
  parseLlmSuggestion,
  runCommanderDecision,
} from '../server/commander';
import type { Robot } from '../shared/types';

function robot(overrides: Partial<Robot> = {}): Robot {
  const base: Robot = {
    id: 'r1', name: '测试机器人', symbol: 'XRPUSDC', createdAt: 0, status: 'running', reason: '',
    cooldownUntil: 0, centerPrice: '1.3', lastRecenterAt: 0, lastQuoteAt: 0,
    positionQty: '0', entryPrice: '0', realizedPnl: '0', fees: '0', filledNotional: '0', fillCount: 0,
    sizingMode: 'base', orderSize: 10, contractSize: 0.1, gridCount: 8, rangeMode: 'fixed',
    halfRange: 0.0025, recenterMinutes: 5, repriceSeconds: 10, orderTtlSeconds: 90,
    closeOffsetMode: 'fixed', closeLongOffset: 0.0002, closeShortOffset: 0.0003,
    leverage: 10, maxPositionNotional: 80, maxOpenNotional: 140, maxOrderNotional: 18,
    stopLossQuote: 15, stopLossPercent: 3, shockPercent: 0.5, cooldownSeconds: 180,
    makerFeeBps: 0.5, inventorySkew: 0.5, exitTimeoutSeconds: 120,
    ...overrides,
  };
  return base;
}

test('guardrail accepts whitelist field within range and clamp', () => {
  const r = robot({ halfRange: 0.0025 });
  const res = guardAiAdjustment(r, { symbol: 'XRPUSDC', adjustments: { halfRange: 0.003 }, reason: '波动加大放宽区间' });
  assert.equal(res.ok, true);
  assert.equal(res.validated?.adjustments.halfRange, 0.003);
});

test('guardrail rejects blacklist field (leverage)', () => {
  const r = robot();
  const res = guardAiAdjustment(r, { symbol: 'XRPUSDC', adjustments: { leverage: 20 }, reason: '想加杠杆' });
  assert.equal(res.ok, false);
  assert.match(res.rejectReason ?? '', /白名单/);
});

test('guardrail rejects value far beyond schema range', () => {
  const r = robot({ halfRange: 0.0025 });
  const res = guardAiAdjustment(r, { symbol: 'XRPUSDC', adjustments: { halfRange: 999999 }, reason: '离谱' });
  assert.equal(res.ok, false);
  // 幅度检查先于范围检查命中：无论哪条，护栏必须拒绝
  assert.ok((res.rejectReason ?? '').includes('幅度') || (res.rejectReason ?? '').includes('范围'));
});

test('guardrail rejects over 50% relative change', () => {
  const r = robot({ orderSize: 10 });
  const res = guardAiAdjustment(r, { symbol: 'XRPUSDC', adjustments: { orderSize: 20 }, reason: '一次性翻倍' });
  assert.equal(res.ok, false);
  assert.match(res.rejectReason ?? '', /调整幅度/);
});

test('guardrail enforces cross-field rule (ttl >= reprice)', () => {
  const r = robot({ repriceSeconds: 30, orderTtlSeconds: 90 });
  const res = guardAiAdjustment(r, { symbol: 'XRPUSDC', adjustments: { orderTtlSeconds: 10 }, reason: '缩短ttl' });
  assert.equal(res.ok, false);
  assert.match(res.rejectReason ?? '', /orderTtlSeconds/);
});

test('guardrail rejects wrong symbol', () => {
  const r = robot();
  const res = guardAiAdjustment(r, { symbol: 'BTCUSDT', adjustments: { halfRange: 0.003 }, reason: 'x' });
  assert.equal(res.ok, false);
});

test('guardrail rejects missing reason', () => {
  const r = robot();
  const res = guardAiAdjustment(r, { symbol: 'XRPUSDC', adjustments: { halfRange: 0.003 } });
  assert.equal(res.ok, false);
  assert.match(res.rejectReason ?? '', /reason/);
});

test('AI_ALLOWED_FIELDS excludes money-sensitive fields', () => {
  const forbidden = ['leverage', 'maxPositionNotional', 'maxOpenNotional', 'maxOrderNotional', 'makerFeeBps', 'closeLongOffset', 'closeShortOffset', 'exitTimeoutSeconds', 'stopLossQuote', 'qtyMode'];
  for (const f of forbidden) assert.ok(!AI_ALLOWED_FIELDS.includes(f as never), `${f} 不应可被 AI 修改`);
});

test('buildAiPrompt includes klines and news', () => {
  const { system, user } = buildAiPrompt({
    symbol: 'XRPUSDC',
    klines: [{ interval: '5m', symbol: 'XRPUSDC', lastPrice: 1.3, changePct: 0.2, prevChangePct: -0.1, high24: 1.31, low24: 1.29, amplitudePct: 1.5, avgVolume: 1000, trend: 1 }],
    news: [{ id: 1, title: '币安上线新币', summary: '' }],
    robot: robot(),
    accountSummary: 'equity=40 USDC',
  });
  assert.match(system, /允许调整的字段/);
  assert.match(user, /XRPUSDC/);
  assert.match(user, /K线摘要/);
  assert.match(user, /币安官方公告/);
});

test('parseLlmSuggestion handles json fences', () => {
  const out = parseLlmSuggestion('```json\n{"symbol":"XRPUSDC","adjustments":{"halfRange":0.003},"reason":"测试"}\n```');
  assert.ok(out);
  assert.equal((out as { adjustments: Record<string, unknown> }).adjustments.halfRange, 0.003);
});

test('parseLlmSuggestion rejects non-json', () => {
  assert.equal(parseLlmSuggestion('不是json'), null);
  assert.equal(parseLlmSuggestion(''), null);
});

test('runCommanderDecision happy path calls apply via validator', async () => {
  const r = robot({ orderSize: 10 });
  const deps = {
    llm: { chat: async () => JSON.stringify({ symbol: 'XRPUSDC', adjustments: { orderSize: 12 }, reason: '增量加大' }) },
  };
  const ctx = { symbol: 'XRPUSDC', klines: [], news: [], robot: r, accountSummary: 'equity=40' };
  const decision = await runCommanderDecision(ctx, r, deps as never, 1);
  assert.ok(decision);
  assert.ok(decision.adjustment);
  assert.equal(decision.adjustment.adjustments.orderSize, 12);
});

test('runCommanderDecision rejects bad suggestion without applying', async () => {
  const r = robot();
  const deps = { llm: { chat: async () => JSON.stringify({ symbol: 'XRPUSDC', adjustments: { leverage: 99 }, reason: '坏建议' }) } };
  const ctx = { symbol: 'XRPUSDC', klines: [], news: [], robot: r, accountSummary: 'x' };
  const decision = await runCommanderDecision(ctx, r, deps as never, 1);
  assert.ok(decision);
  assert.equal(decision.adjustment, null);
  assert.ok(decision.rejected);
});

test('runCommanderDecision handles llm failure gracefully', async () => {
  const r = robot();
  const deps = { llm: { chat: async () => { throw new Error('LLM 挂了'); } } };
  const ctx = { symbol: 'XRPUSDC', klines: [], news: [], robot: r, accountSummary: 'x' };
  const decision = await runCommanderDecision(ctx, r, deps as never, 1);
  assert.ok(decision);
  assert.equal(decision.adjustment, null);
  assert.match(decision.rejected?.reason ?? '', /LLM/);
});