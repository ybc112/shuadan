import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supertrend, trueRanges, wilderSmooth } from '../server/supertrend';

function candle(close: number, high = close, low = close) { return { high, low, close }; }

test('supertrend: 上升趋势返回 +1，下降趋势返回 -1', () => {
  const rising = Array.from({ length: 30 }, (_, i) => candle(100 + i * 2, 101 + i * 2, 99 + i * 2));
  const result = supertrend(rising, 3, 1.5);
  assert.ok(result);
  assert.equal(result.direction, 1);
  assert.ok(result.atr > 0);

  const falling = Array.from({ length: 30 }, (_, i) => candle(200 - i * 3, 201 - i * 3, 199 - i * 3));
  const result2 = supertrend(falling, 3, 1.5);
  assert.ok(result2);
  assert.equal(result2.direction, -1);
});

test('supertrend: 突发放量上穿由空转多', () => {
  const candles = [
    candle(100), candle(99), candle(98), candle(97), candle(96), candle(95),
    candle(94), candle(93), candle(92), candle(91), candle(92),
    candle(110, 112, 90), // 剧烈波动后大阳线
    candle(115, 116, 105), candle(118, 119, 110),
  ];
  const result = supertrend(candles, 3, 1.5);
  assert.ok(result);
  assert.equal(result.direction, 1);
});

test('supertrend: 数据不足返回 null', () => {
  assert.equal(supertrend([candle(1), candle(2)], 3, 1.5), null);
  assert.equal(supertrend([], 3, 1.5), null);
});

test('trueRanges: 首根为高减低，后续取最大', () => {
  const trs = trueRanges([candle(10, 12, 8), candle(10, 11, 9), candle(15, 16, 14)]);
  assert.equal(trs[0], 4);
  assert.equal(trs[1], Math.max(2, Math.abs(11 - 10), Math.abs(9 - 10))); // 2
  assert.equal(trs[2], Math.max(2, Math.abs(16 - 10), Math.abs(14 - 10))); // 6
});

test('wilderSmooth: 前 window-1 个 NaN，随后平滑收敛', () => {
  const out = wilderSmooth([1, 2, 3, 4], 3);
  assert.ok(Number.isNaN(out[0]));
  assert.ok(Number.isNaN(out[1]));
  assert.equal(out[2], 2); // sma(1,2,3)
  assert.equal(out[3], (2 * 2 + 4) / 3);
});