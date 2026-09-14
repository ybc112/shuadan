import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, robotSchema } from '../shared/config';
import type { QuoteAccount } from '../shared/types';
import { D, ceilStep, floorStep, gridLevels, makerPrice, orderQuantity, positionAfterFill } from '../server/math';
import { sampleMarkets } from '../server/markets';

const btc = sampleMarkets(100000).find(m => m.symbol === 'BTCUSDC')!;
const config = defaultConfig(btc);
const account: QuoteAccount = { asset: 'USDC', wallet: '10000', equity: '10000', available: '5000', usedMargin: '5000', unrealizedPnl: '0' };

test('decimal tick rounding does not introduce binary-float errors', () => {
  assert.equal(floorStep('0.12345679', '0.000001').toFixed(), '0.123456');
  assert.equal(ceilStep('0.12345679', '0.000001').toFixed(), '0.123457');
  assert.equal(floorStep('79149.299999', '0.1').toFixed(), '79149.2');
});

test('all Maker quotes remain passive even when their targets cross the book', () => {
  assert(D(makerPrice('BUY', '999999', btc)).lte(btc.bid));
  assert(D(makerPrice('SELL', '1', btc)).gte(btc.ask));
  assert.throws(() => makerPrice('BUY', '100', { ...btc, bid: '100', ask: '99' }), /盘口无效/);
});

test('U sizing is floored to base-asset lots and does not multiply by leverage', () => {
  assert.equal(orderQuantity({ ...config, orderSize: 100, leverage: 10 }, btc, '79149', account), '0.001');
  assert.equal(orderQuantity({ ...config, orderSize: 100, leverage: 1 }, btc, '79149', account), '0.001');
  assert.throws(() => orderQuantity({ ...config, orderSize: 20 }, btc, '79149', account), /单格数量不足/);
});

test('custom contracts and account percentages convert consistently', () => {
  assert.equal(orderQuantity({ ...config, sizingMode: 'contracts', orderSize: 3, contractSize: 0.001 }, btc, '10000', account), '0.003');
  assert.equal(orderQuantity({ ...config, sizingMode: 'equity_pct', orderSize: 1 }, btc, '10000', account), '0.01');
  assert.equal(orderQuantity({ ...config, sizingMode: 'available_pct', orderSize: 1 }, btc, '10000', account), '0.005');
});

test('tiny, oversized and below-notional orders are rejected, never rounded up', () => {
  const instrument = { ...btc, minNotional: '10' };
  assert.throws(() => orderQuantity({ ...config, sizingMode: 'base', orderSize: 0.001 }, instrument, '1000', account), /最小名义金额/);
  assert.throws(() => orderQuantity({ ...config, orderSize: 1000 }, btc, '10000', account), /单笔/);
  assert.throws(() => orderQuantity({ ...config, sizingMode: 'base', orderSize: 1 }, { ...btc, maxQty: '0.1' }, '100', account), /交易规则上限/);
});

test('18-grid fixed +/-400 layout has exactly 9 passive levels per side', () => {
  const levels = gridLevels({ ...config, gridCount: 18, rangeMode: 'fixed', halfRange: 400 }, btc, '79149');
  assert.equal(levels.filter(l => l.side === 'BUY').length, 9);
  assert.equal(levels.filter(l => l.side === 'SELL').length, 9);
  assert.equal(new Set(levels.map(l => l.price)).size, 18);
  for (const level of levels) assert(D(level.price).mod(btc.priceTick).isZero());
  assert.throws(() => gridLevels({ ...config, halfRange: 0.000001, rangeMode: 'fixed' }, btc), /网格过密/);
  assert.throws(() => gridLevels({ ...config, halfRange: 100000, rangeMode: 'fixed' }, btc), /下界/);
});

test('partial close and position flips preserve correct average entry and realized PnL', () => {
  assert.deepEqual(positionAfterFill('2', '100', 'SELL', '1', '110'), { positionQty: '1', entryPrice: '100', realizedPnl: '10' });
  assert.deepEqual(positionAfterFill('2', '100', 'SELL', '3', '90'), { positionQty: '-1', entryPrice: '90', realizedPnl: '-20' });
  assert.deepEqual(positionAfterFill('-2', '100', 'BUY', '2', '90'), { positionQty: '0', entryPrice: '0', realizedPnl: '20' });
  assert.deepEqual(positionAfterFill('1', '100', 'BUY', '1', '120'), { positionQty: '2', entryPrice: '110', realizedPnl: '0' });
});

test('schema rejects nonfinite amounts, high leverage, odd grids and unlimited quoting', () => {
  for (const update of [{ orderSize: NaN }, { leverage: 150 }, { gridCount: 17 }, { repriceSeconds: 1 }, { orderTtlSeconds: 10, repriceSeconds: 20 }, { sizingMode: 'equity_pct', orderSize: 11 }]) {
    assert.equal(robotSchema.safeParse({ ...config, ...update }).success, false);
  }
  assert.equal(robotSchema.safeParse({ ...config, orderType: 'MARKET' }).success, false);
});
