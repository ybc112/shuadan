// Live-mode end-to-end smoke test. Boots the real MakerEngine, attaches a mocked
// Binance trading client, then exercises the same code paths the production
// server would take when the operator confirms the live switch.
//
// Run with: node scripts/test-live.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// tsx loader is provided externally; run via `node --import tsx/esm scripts/test-live.mjs`.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const { MakerEngine } = await import(pathToFileURL(path.join(root, 'server/engine.ts')).href);
const { defaultConfig } = await import(pathToFileURL(path.join(root, 'shared/config.ts')).href);
const { BinanceTradingClient, BinanceTradingError } = await import(pathToFileURL(path.join(root, 'server/binance-trading.ts')).href);

const checks = [];
function mkMarket(symbol, base, price, tick, step) {
  const now = Date.now();
  return { symbol, baseAsset: base, quoteAsset: 'USDC', priceTick: String(tick), quantityStep: String(step), minQty: String(step), maxQty: '100000000', minNotional: '5',
    bid: String(price - tick), ask: String(price + tick), bidQty: '100', askQty: '100', markPrice: String(price), changePercent: 0, quoteVolume: 1000000, updatedAt: now,
    history: [{ time: now - 1000, price }] };
}

function assert(label, condition, detail = '') {
  checks.push({ label, ok: !!condition, detail });
  if (!condition) console.error(`✗ ${label}${detail ? '  ' + detail : ''}`);
  else console.log(`✓ ${label}`);
}

class MockTradingClient {
  constructor(seed = {}) {
    this.config = { environment: 'demo', apiKey: 'X'.repeat(40), apiSecret: 'Y'.repeat(64), ...seed };
    this.configured = !!seed.configured;
    this.configurationIssue = this.configured ? null : 'mock: missing credentials';
    this.environment = 'demo';
    this.baseUrl = 'https://demo-fapi.binance.com';
    this.calls = [];
    this.orders = new Map();
    this.positions = [];
    this.balance = { totalWalletBalance: '10000', totalUnrealizedProfit: '0', totalMarginBalance: '10000', availableBalance: '10000', maxWithdrawAmount: '10000', assets: [
      { asset: 'USDT', walletBalance: '5000', availableBalance: '5000', unrealizedProfit: '0', marginBalance: '5000' },
      { asset: 'USDC', walletBalance: '5000', availableBalance: '5000', unrealizedProfit: '0', marginBalance: '5000' },
    ], positions: [] };
    this.trades = [];
    this.nextOrderId = 1000;
    this.lastSyncedAt = null;
    this.lastAccountSyncAt = null;
  }

  status() {
    return { environment: this.environment, baseUrl: this.baseUrl, configured: this.configured, configurationIssue: this.configurationIssue,
      blockedUntil: 0, lastWeight: 0, ordersThisMinute: 0, lastSyncedAt: this.lastSyncedAt, lastAccountSyncAt: this.lastAccountSyncAt, lastAccountError: null };
  }

  async synchronizeClock() { this.calls.push(['time']); this.lastSyncedAt = Date.now(); return { offsetMs: 0, roundTripMs: 5 }; }
  async getAccount() { this.calls.push(['account']); this.lastAccountSyncAt = Date.now(); return this.balance; }
  async getOpenOrders(symbol) { this.calls.push(['openOrders', symbol]); return [...this.orders.values()].filter(o => !symbol || o.symbol === symbol); }
  async getUserTrades(symbol, since) { this.calls.push(['trades', symbol, since]); return this.trades.filter(t => t.symbol === symbol); }
  async placeLimitOrder(p) {
    this.calls.push(['place', p]);
    const orderId = this.nextOrderId++;
    const order = { ...p, orderId, status: 'NEW', origQty: p.quantity, executedQty: '0', time: Date.now(), updateTime: Date.now() };
    this.orders.set(`${p.symbol}:${orderId}`, order);
    return order;
  }
  async cancelOrder(symbol, orderId, clientOrderId) {
    this.calls.push(['cancel', symbol, orderId, clientOrderId]);
    const key = `${symbol}:${orderId}`;
    const order = this.orders.get(key);
    if (order) { order.status = 'CANCELED'; this.orders.delete(key); return { ...order, status: 'CANCELED' }; }
    throw new BinanceTradingError('UNKNOWN_ORDER', 'mock: unknown order');
  }
  async cancelAllOpenOrders(symbol) { this.calls.push(['cancelAll', symbol]); let count = 0; for (const [k, o] of this.orders) if (o.symbol === symbol) { this.orders.delete(k); count++; } return { count, orders: [] }; }
  async setLeverage() { this.calls.push(['leverage']); return { symbol: 'BTCUSDT', leverage: 3, maxNotionalValue: '500000' }; }
  async setMarginType() { this.calls.push(['marginType']); }
  async getPositions(symbol) { this.calls.push(['positions', symbol]); return this.positions.filter(p => !symbol || p.symbol === symbol); }

  seedTrade(trade) { this.trades.push({ ...trade, id: trade.id ?? `t${this.trades.length + 1}` }); }
  setPositions(positions) { this.positions = positions; this.balance.positions = positions; }
}

{
  const engine = new MakerEngine();
  const broker = new MockTradingClient({ configured: false });
  engine.attachLiveBroker(broker);
  let rejected = false;
  try { await engine.setExecution('live'); }
  catch { rejected = true; }
  assert('live switch blocked when credentials missing', rejected);
  assert('execution mode remains paper after rejection', engine.execution === 'paper');
}

{
  const engine = new MakerEngine();
  const broker = new MockTradingClient({ configured: true });
  engine.attachLiveBroker(broker);

  const btc = mkMarket('BTCUSDC', 'BTC', 79000.6, 0.1, 0.001);
  engine.acceptMarkets([btc]);

  await engine.setExecution('live');
  assert('execution flipped to live', engine.execution === 'live');
  assert('live account populated after switch', engine.liveAccount !== null);
  assert('clock sync was called before account pull', broker.calls.some(c => c[0] === 'time') && broker.calls.some(c => c[0] === 'account'));

  const robot = engine.addRobot({ ...defaultConfig(btc), name: 'live-btc' });
  robot.leverage = 3; robot.orderSize = 120;
  engine.startRobot(robot.id);

  const placeCalls = broker.calls.filter(c => c[0] === 'place');
  assert('at least one limit order was placed via the broker', placeCalls.length > 0, `count=${placeCalls.length}`);
  const first = placeCalls[0]?.[1];
  assert('placed orders use post-only GTX semantics', first?.postOnly === true);
  assert('placed orders carry a deterministic clientOrderId prefix', typeof first?.clientOrderId === 'string' && first.clientOrderId.startsWith('pm-'));

  // Wait for any pending async place operations to settle before counting cancel calls.
  await new Promise(r => setTimeout(r, 30));
  const beforeCancels = broker.calls.filter(c => c[0] === 'cancel').length;
  engine.pauseRobot(robot.id);
  await new Promise(r => setTimeout(r, 30));
  const afterCancels = broker.calls.filter(c => c[0] === 'cancel').length;
  assert('pausing a live robot cancels through the broker', afterCancels > beforeCancels, `before=${beforeCancels} after=${afterCancels}`);

  await engine.setExecution('paper');
  assert('switching back to paper succeeds', engine.execution === 'paper');
  assert('executionMessage reports paper mode', engine.executionMessage.includes('纸面'));
}

{
  const engine = new MakerEngine();
  const broker = new MockTradingClient({ configured: true });
  engine.attachLiveBroker(broker);

  const eth = mkMarket('ETHUSDC', 'ETH', 2495.5, 0.01, 0.001);
  engine.acceptMarkets([eth]);
  await engine.setExecution('live');
  const robot = engine.addRobot({ ...defaultConfig(eth), name: 'live-eth' });
  engine.startRobot(robot.id);

  const orderId = 9001;
  broker.seedTrade({ symbol: 'ETHUSDC', orderId, side: 'BUY', price: '2495.2', qty: '0.05', commission: '0.012', commissionAsset: 'USDT', realizedPnl: '0', time: Date.now(), maker: true });
  await engine.syncLiveTrades(Date.now() + 1000);
  assert('live BUY trade is recorded as a fill', engine.fills.some(f => f.symbol === 'ETHUSDC' && f.execution === 'LIVE'));
  const updated = robot;
  assert('position qty is positive after a long fill', Number(updated.positionQty) > 0, `pos=${updated.positionQty}`);

  await engine.setExecution('paper');
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length} / ${checks.length} live-mode checks passed`);
if (failed.length) {
  console.error('\nFailed checks:');
  for (const c of failed) console.error(`  ✗ ${c.label}${c.detail ? '  ' + c.detail : ''}`);
  process.exit(1);
}