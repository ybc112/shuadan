import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MakerEngine } from '../server/engine';
import { ActionBudget } from '../server/rate-limit';
import { D } from '../server/math';
import { defaultConfig } from '../shared/config';
import type { Market, Robot } from '../shared/types';

const T = Date.UTC(2026, 8, 10, 10, 0, 0);
function setup() {
  const engine = new MakerEngine(undefined, T);
  engine.robots = [];
  engine.wallets = { USDC: '10000', USDT: '10000' }; // 测试注入纸面余额，验证风控逻辑
  engine.dailyStartEquity = '20000'; engine.peakEquity = '20000';
  const market: Market = { symbol: 'SOLUSDC', baseAsset: 'SOL', quoteAsset: 'USDC',
    bid: '99.99', ask: '100.01', bidQty: '100', askQty: '100', markPrice: '100',
    priceTick: '0.01', quantityStep: '0.01', minQty: '0.01', maxQty: '1000000', minNotional: '5',
    changePercent: 0, quoteVolume: 0, updatedAt: T,
    history: [{ time: T - 9000, price: 100 }, { time: T, price: 100 }] };
  engine.acceptMarkets([market], T);
  const robot = engine.addRobot({ ...defaultConfig(market), gridCount: 4, rangeMode: 'fixed', halfRange: 2, orderSize: 100, maxOrderNotional: 200, repriceSeconds: 5, shockPercent: 5, cooldownSeconds: 10 }, T);
  return { engine, robot, market };
}
function move(engine: MakerEngine, base: Market, value: number, at: number, extra: Partial<Market> = {}) {
  const prev = engine.market(base.symbol);
  const next = { ...prev, bid: D(value).minus('0.01').toFixed(), ask: D(value).plus('0.01').toFixed(), markPrice: String(value), updatedAt: at,
    history: [...prev.history, { time: at, price: value }], ...extra };
  engine.acceptMarkets([next], at); engine.step(at); return next;
}

test('new robots are paused; duplicate contracts cannot create self-matching books', () => {
  const { engine, robot, market } = setup();
  assert.equal(robot.status, 'paused'); assert.equal(engine.orders.length, 0);
  assert.throws(() => engine.addRobot(defaultConfig(market), T), /已有机器人/);
});

test('new orders cannot fill on the quote snapshot or repeated market timestamps', () => {
  const { engine, robot, market } = setup(); engine.startRobot(robot.id, T);
  assert.equal(engine.orders.length, 4);
  engine.step(T); assert.equal(engine.fills.length, 0);
  move(engine, market, 98.8, T + 1000, { askQty: '0.5' });
  assert(engine.fills.length > 0);
  const count = engine.fills.length;
  engine.step(T + 1500); assert.equal(engine.fills.length, count);
});

test('partial fills use only limited book liquidity and reserve only remaining quantity', () => {
  const { engine, robot, market } = setup(); engine.startRobot(robot.id, T);
  const order = engine.orders.find(o => o.side === 'BUY' && o.price === '99')!;
  const initial = D(order.remaining);
  move(engine, market, 98.8, T + 1000, { askQty: '0.5' });
  assert.equal(order.status, 'PARTIALLY_FILLED');
  assert(D(order.remaining).eq(initial.minus('0.05')));
  assert.equal(robot.positionQty, '0.05');
  assert(D(engine.wallets.USDC).lt(10000)); assert.equal(engine.wallets.USDT, '10000');
  assert.equal(engine.fills[0].execution, 'SIMULATED'); assert.equal(engine.fills[0].liquidity, 'MAKER');
});

test('touching but not crossing a resting price does not claim a fill', () => {
  const { engine, robot, market } = setup(); engine.startRobot(robot.id, T);
  move(engine, market, 99, T + 1000, { bid: '98.99', ask: '99' });
  assert.equal(engine.fills.length, 0);
});

test('gap fills are accounted for before volatility cancellation', () => {
  const { engine, robot, market } = setup(); robot.shockPercent = 1; engine.startRobot(robot.id, T);
  move(engine, market, 96, T + 1000);
  assert(Number(robot.positionQty) > 0, 'resting bids must be allowed to fill before the breaker');
  assert.equal(robot.status, 'cooldown'); assert.equal(engine.orders.length, 0);
  assert.throws(() => engine.startRobot(robot.id, T + 2000), /冷却/);
});

test('stale feed cancels all quotes even if normal action budget is exhausted', () => {
  const { engine, robot } = setup(); engine.settings.maxActionsPerMinute = 4; engine.startRobot(robot.id, T);
  assert.equal(engine.orders.length, 4);
  engine.step(T + 9000);
  assert.equal(engine.orders.length, 0); assert.equal(robot.status, 'cooldown');
  assert(engine.summary(T + 9000).actionsLastMinute > engine.settings.maxActionsPerMinute);
  assert.throws(() => engine.startRobot(robot.id, T + 20000), /行情/);
});

test('invalid or crossed books cannot produce fills and fail closed', () => {
  const { engine, robot, market } = setup(); engine.startRobot(robot.id, T);
  move(engine, market, 98, T + 1000, { bid: '100', ask: '90' });
  assert.equal(engine.fills.length, 0); assert.equal(engine.orders.length, 0); assert.equal(robot.status, 'cooldown');
});

test('same-side pending orders count toward worst possible position', () => {
  const { engine, robot } = setup(); robot.maxPositionNotional = 150; engine.startRobot(robot.id, T);
  assert.equal(engine.orders.filter(o => o.side === 'BUY').length, 1);
  assert.equal(engine.orders.filter(o => o.side === 'SELL').length, 1);
});

test('global and per-account budgets include pending orders without netting buys against sells', () => {
  const { engine, robot } = setup(); engine.settings.maxGrossNotional = 150; engine.startRobot(robot.id, T);
  assert.equal(engine.orders.length, 1);
  assert(engine.summary(T).reservedNotional <= 150);
  const { engine: other, robot: r2 } = setup();
  other.wallets.USDC = '50'; other.wallets.USDT = '19950';
  other.settings.maxMarginPercent = 40;
  other.startRobot(r2.id, T);
  assert.equal(other.orders.length, 0, 'USDT cash cannot cover a USDC budget');
});

test('reduce-only execution is clamped per fill and can never reverse the position', () => {
  const { engine, robot, market } = setup();
  robot.positionQty = '0.5'; robot.entryPrice = '100';
  engine.reduceRobot(robot.id, T);
  const order = engine.orders[0]; assert.equal(order.side, 'SELL'); assert.equal(order.reduceOnly, true);
  // Position shrinks while the order is still resting: outstanding quantity must be clamped.
  robot.positionQty = '0.2';
  move(engine, market, 101, T + 1000);
  assert.equal(robot.positionQty, '0'); assert.equal(engine.orders.length, 0);
  // 正常减仓归零后自动恢复刷量（2026-09-13 起行为：止损归零才暂停）
  assert.equal(robot.status, 'running'); assert.match(robot.reason, /自动恢复/);
});

test('short close uses the configured independent fixed offset and post-only clamp', () => {
  const { engine, robot } = setup(); robot.positionQty = '-1'; robot.entryPrice = '100';
  robot.closeOffsetMode = 'fixed'; robot.closeShortOffset = 3; robot.closeLongOffset = 2;
  engine.reduceRobot(robot.id, T);
  assert.equal(engine.orders[0].price, '97'); assert.equal(engine.orders[0].side, 'BUY');
  assert.equal(engine.orders[0].reduceOnly, true);
});

test('near-limit inventory switches to only-reducing orders', () => {
  const { engine, robot, market } = setup(); robot.maxPositionNotional = 1000;
  engine.startRobot(robot.id, T); robot.positionQty = '8.5'; robot.entryPrice = '100';
  move(engine, market, 100, T + 6000);
  assert.equal(robot.status, 'reduce_only'); assert(engine.orders.every(o => o.reduceOnly && o.side === 'SELL'));
});

test('daily loss kill is latched, preserves inventory and blocks new orders', () => {
  const { engine, robot, market } = setup();
  engine.settings.dailyLossLimit = 10; robot.positionQty = '20'; robot.entryPrice = '101';
  move(engine, market, 100, T + 1000);
  assert.equal(engine.emergencyStopped, true); assert.equal(robot.positionQty, '20');
  assert.equal(engine.orders.length, 0); assert.throws(() => engine.startRobot(robot.id, T + 1000), /全局/);
  assert.throws(() => engine.clearStop(T + 1000), /亏损/);
});

test('pause, edit and emergency stop cancel orders but never erase positions', () => {
  const { engine, robot, market } = setup(); engine.startRobot(robot.id, T); robot.positionQty = '0.1'; robot.entryPrice = '100';
  engine.pauseRobot(robot.id, T + 1000); assert.equal(robot.positionQty, '0.1'); assert.equal(engine.orders.length, 0);
  engine.editRobot(robot.id, { ...defaultConfig(market), name: 'Changed' }, T + 1000); assert.equal(robot.positionQty, '0.1');
  assert.throws(() => engine.deleteRobot(robot.id, T + 1000), /仍有持仓/);
  engine.stopAll('test', T + 1000); assert.equal(robot.positionQty, '0.1'); assert.equal(robot.status, 'paused');
  engine.clearStop(T + 1000); assert.equal(robot.status, 'paused');
});

test('source changes cannot revalue an open simulated position against another source', () => {
  const { engine, robot } = setup(); robot.positionQty = '0.1';
  assert.throws(() => engine.switchSource('simulation', T), /尚有持仓/);
});

test('restart preserves balances and positions but never re-arms a robot or old orders', () => {
  const { engine, robot } = setup(); engine.startRobot(robot.id, T); robot.positionQty = '0.2'; robot.entryPrice = '100';
  const restored = new MakerEngine(structuredClone(engine.persist()), T + 1000);
  assert.equal(restored.robots[0].positionQty, '0.2'); assert.equal(restored.orders.length, 0);
  assert.equal(restored.robots[0].status, 'paused'); assert.deepEqual(restored.wallets, engine.wallets);
});

test('missing market retains the last mark and stale protection rather than hiding unrealized loss', () => {
  const { engine, robot } = setup(); robot.positionQty = '1'; robot.entryPrice = '101';
  engine.acceptMarkets([], T + 9000); engine.step(T + 9000);
  assert.equal(engine.summary(T + 9000).unrealizedPnl, -1);
  assert.equal(robot.status, 'cooldown');
});

test('expired pending orders are canceled even when ordinary recenter budget is exhausted', () => {
  const { engine, robot, market } = setup(); robot.orderTtlSeconds = 10; robot.recenterMinutes = 1;
  engine.settings.maxActionsPerMinute = 4; engine.startRobot(robot.id, T);
  move(engine, market, 100, T + 11000);
  assert.equal(engine.orders.length, 0);
});

test('tiny residual inventory is retained and explicitly marked as not executable', () => {
  const { engine, robot } = setup(); robot.positionQty = '0.01'; robot.entryPrice = '100';
  engine.reduceRobot(robot.id, T); assert.equal(engine.orders.length, 0); assert.equal(robot.positionQty, '0.01');
  assert.match(robot.reason, /最小挂单/);
});

test('a robot stuck on un-closeable dust returns to the grid instead of dead-locking', () => {
  const { engine, robot } = setup();
  // 0.01 SOL × 100 = 1 USDC，低于 minNotional 5：作为 Maker 永远挂不出去，
  // 而只减仓必须等仓位归零才回网格 —— 旧实现会永久卡死（既不挂单也不恢复），只能人工复位。
  // 实测 2026-09-14 09:51 在 XRPUSDC 上卡于 2.4 XRP ≈ 3.36 USDC。
  robot.positionQty = '0.01'; robot.entryPrice = '100';
  robot.status = 'reduce_only'; robot.reason = '仅挂 Reduce-only 限价单，等待被动成交';
  engine.step(T + 1000);
  assert.equal(robot.status, 'running');
  assert.equal(robot.positionQty, '0.01'); // 残余保留，不引入市价单，维持「只做 Maker」的设计
});

test('inventory skew pulls the grid against the position so it mean-reverts', () => {
  const { engine, robot } = setup();
  const MID = 100;
  const shape = () => {
    const buys = engine.orders.filter(o => o.side === 'BUY').map(o => Number(o.price));
    const sells = engine.orders.filter(o => o.side === 'SELL').map(o => Number(o.price));
    return { nearBuy: MID - Math.max(...buys), nearSell: Math.min(...sells) - MID, n: engine.orders.length };
  };

  // 基准：无持仓、inventorySkew=0 -> 买卖必须对称
  engine.startRobot(robot.id, T);
  const flat = shape();
  assert.ok(flat.n > 0);
  assert.ok(Math.abs(flat.nearBuy - flat.nearSell) < 0.02, `对称网格被破坏: ${JSON.stringify(flat)}`);

  // 多头 + 开启偏斜 -> 卖单应更贴近盘口，买单更远（网格倾向减仓）
  engine.pauseRobot(robot.id, T);
  robot.inventorySkew = 1;
  robot.positionQty = '10'; robot.entryPrice = '100';
  robot.centerPrice = '0'; robot.lastRecenterAt = 0;
  engine.startRobot(robot.id, T + 1000);
  const skewed = shape();
  assert.ok(skewed.nearSell < skewed.nearBuy,
    `多头时应偏向卖出（近卖 ${skewed.nearSell} 应 < 近买 ${skewed.nearBuy}）`);
});

test('open-position stop-loss scales with position size instead of needing an unrealistic move', () => {
  const { engine, robot } = setup();
  // 实测问题：stopLossQuote=15 是绝对额、针对累计亏损；而单边行情亏在「当前持仓的浮亏」上，
  // 配上 80 USDC 的仓位上限要行情走 19%~75% 才触发，一整天 0 次。
  // 这里把绝对阈值设得很大（单独用绝不会触发），验证比例阈值能拦住浮亏。
  robot.stopLossQuote = 80;
  robot.stopLossPercent = 3;
  robot.status = 'running';
  robot.positionQty = '1'; robot.entryPrice = '103';   // 名义额 100 USDC，浮亏 3 USDC = 3%
  engine.step(T + 1000);
  assert.equal(robot.status, 'reduce_only');
  assert.match(robot.reason, /浮亏达到上限/);

  // 关掉比例阈值后同样浮亏不应再拦（证明拦截来自比例阈值而非绝对阈值）
  const second = setup();
  second.robot.stopLossQuote = 80;
  second.robot.stopLossPercent = 0;
  second.robot.status = 'running';
  second.robot.positionQty = '1'; second.robot.entryPrice = '103';
  second.engine.step(T + 1000);
  assert.equal(second.robot.status, 'running');
});

test('emergency stop keeps the position for human review, and clearStop can explicitly rebaseline', () => {
  const { engine, robot, market } = setup();
  robot.positionQty = '1'; robot.entryPrice = '100';
  engine.startRobot(robot.id, T);        // 先正常启动（此时还没超限）
  engine.peakEquity = '30000';           // 再制造 33% 回撤，模拟持续亏损后的状态
  engine.stopAll('测试熔断', T + 1000);
  assert.equal(engine.emergencyStopped, true);
  // 作者的设计：熔断保留持仓并置为 paused，交人工复核——不自动平仓，避免正好卖在浮亏低点
  assert.equal(robot.status, 'paused');
  assert.equal(robot.positionQty, '1');
  // 默认调用在超限时仍然拒绝（保底不放行）
  assert.throws(() => engine.clearStop(T + 1000), /亏损|回撤/);
  // 人工复核后用显式 rebaseline 解除，并重置风控基准——否则回撤锁会永久卡死启不起来
  engine.clearStop(T + 2000, true);
  assert.equal(engine.emergencyStopped, false);
  assert.equal(Number(engine.peakEquity), Number(engine.summary(T + 2000).equity));
});

test('a reduce-only order that cannot fill escalates to a crossing order after the timeout', () => {
  const { engine, robot, market } = setup();
  // 实测：Maker 减仓单在单边行情里挂不出去（卖单必须挂卖一或更高，价格一路跌就一直追在盘口上方，
  // 撤单重挂还丢排位），8 分钟 0 成交，最终裸仓 6.9 小时亏 5.56 U。
  robot.exitTimeoutSeconds = 60;
  robot.status = 'reduce_only';
  robot.positionQty = '1'; robot.entryPrice = '100';
  robot.lastQuoteAt = 0;

  engine.step(T + 1000);
  const maker = engine.orders.find(o => o.reduceOnly);
  assert.ok(maker, '应挂出减仓单');
  assert.ok(Number(maker.price) >= 100.01, `未超时应挂在卖一以上（Maker），实际 ${maker.price}`);

  // 推进到超时之后；同时刷新行情避免被判为断流
  const next = move(engine, market, 100, T + 62000);
  const crossed = engine.orders.filter(o => o.reduceOnly).at(-1);
  assert.ok(crossed, '超时后仍应有减仓单');
  assert.ok(Number(crossed.price) <= Number(next.bid),
    `超时后应跨价挂在买一（立即成交），实际 ${crossed.price} 应 ≤ ${next.bid}`);
});

test('flattenOnStop makes a global stop enter reduce-only instead of leaving a naked position', () => {
  const { engine, robot } = setup();
  engine.settings.flattenOnStop = true;
  robot.positionQty = '1'; robot.entryPrice = '100';
  engine.startRobot(robot.id, T);
  engine.stopAll('测试熔断', T + 1000);
  assert.equal(engine.emergencyStopped, true);
  assert.equal(robot.status, 'reduce_only', '开启 flattenOnStop 后应转入只减仓平掉持仓');
});

test('risk cancellations can exceed normal limits, which then recover after rolling 60 seconds', () => {
  const budget = new ActionBudget(); assert.equal(budget.take(10, T, 10), true); assert.equal(budget.take(1, T, 10), false);
  budget.recordCancellation(10, T + 1); assert.equal(budget.count(T + 1), 20);
  assert.equal(budget.take(1, T + 60001, 10), true);
});
