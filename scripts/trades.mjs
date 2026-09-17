#!/usr/bin/env node
/**
 * 成交流水查询与盈亏分析。
 *
 *   node scripts/trades.mjs                     摘要 + 按币种/流动性/执行模式分组
 *   node scripts/trades.mjs --recent 30         最近 30 笔明细
 *   node scripts/trades.mjs --daily             按日汇总
 *   node scripts/trades.mjs --backfill          把 data/state.json 里的 fills 补写进库
 *   node scripts/trades.mjs --db /path/trades.db
 *
 * 关键指标是「净额 / 成交额(bps)」：它才是这套网格有没有 edge 的判据。
 * 只看盈亏金额会被方向性运气误导——必须除以对应的成交量。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const dataDir = arg('--data', process.env.MAKER_DATA_DIR ?? new URL('../data', import.meta.url).pathname);
const dbPath = arg('--db', path.join(dataDir, 'trades.db'));

const n = (v) => Number(v ?? 0) || 0;
const f = (v, d = 4) => n(v).toFixed(d);
const sgn = (v, d = 4) => (n(v) >= 0 ? '+' : '') + n(v).toFixed(d);
const bps = (net, turnover) => (n(turnover) === 0 ? '—' : ((n(net) / n(turnover)) * 10000).toFixed(2) + ' bps');
/**
 * 手续费按币安 commission 的原始符号存储：**负 = 返佣入账，正 = 付费出账**。
 * 本账户实测 makerCommissionRate = -0.000050（返佣 0.005%），taker = +0.000138。
 * 因此手续费对盈亏的贡献是 -fee，早期版本按 +fee 加总会把符号算反。
 */
const feeIncome = (fee) => -n(fee);

if (!existsSync(dbPath)) {
  console.error(`未找到流水库：${dbPath}\n机器人启动后才会创建；或先跑 --backfill 前先确认 data/state.json 存在。`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

if (argv.includes('--backfill')) {
  const stateFile = path.join(dataDir, 'state.json');
  if (!existsSync(stateFile)) { console.error(`未找到 ${stateFile}`); process.exit(1); }
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const names = new Map((state.robots ?? []).map(r => [r.id, r.name]));
  const insert = db.prepare(`INSERT OR IGNORE INTO trades
    (id, trade_id, order_id, robot_id, robot_name, symbol, side, price, quantity,
     quote_qty, fee, realized_pnl, liquidity, execution, trade_time, logged_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  for (const x of state.fills ?? []) {
    const r = insert.run(x.id, x.tradeId ?? null, x.orderId, x.robotId, names.get(x.robotId) ?? null,
      x.symbol, x.side, x.price, x.quantity, (n(x.price) * n(x.quantity)).toFixed(),
      x.fee, x.realizedPnl, x.liquidity, x.execution, x.time, Date.now());
    if (Number(r.changes) > 0) added++;
  }
  console.log(`回填完成：新增 ${added} 条，state.json 共 ${(state.fills ?? []).length} 条。`);
  db.close();
  process.exit(0);
}

const line = (c = '─') => console.log(c.repeat(74));

// ---------- 总览 ----------
const t = one(`SELECT COUNT(*) c, MIN(trade_time) t0, MAX(trade_time) t1,
  SUM(CAST(quote_qty AS REAL)) turnover, SUM(CAST(fee AS REAL)) fee,
  SUM(CAST(realized_pnl AS REAL)) realized
  FROM trades`);
const net = n(t.realized) + feeIncome(t.fee);
const fmtTime = (ms) => (ms ? new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }) : '—');

console.log(`\n流水库 ${dbPath}`);
line('═');
console.log(`成交笔数        ${t.c}`);
console.log(`时间跨度        ${fmtTime(t.t0)}  →  ${fmtTime(t.t1)}`);
console.log(`成交总额        ${f(t.turnover, 2)} USDC`);
console.log(`手续费收入      ${sgn(feeIncome(t.fee), 6)} USDC   (${bps(feeIncome(t.fee), t.turnover)})`);
console.log(`已实现盈亏(毛)  ${sgn(t.realized, 6)} USDC   (${bps(t.realized, t.turnover)})`);
console.log(`净额(毛盈亏+费) ${sgn(net, 6)} USDC   (${bps(net, t.turnover)})   ← edge 判据`);
line();

// ---------- 权益快照 ----------
const snap = one(`SELECT COUNT(*) c, MIN(ts) t0, MAX(ts) t1 FROM equity_snapshots`);
if (snap.c > 0) {
  const first = one(`SELECT * FROM equity_snapshots ORDER BY ts ASC LIMIT 1`);
  const last = one(`SELECT * FROM equity_snapshots ORDER BY ts DESC LIMIT 1`);
  console.log(`权益快照        ${snap.c} 条，${fmtTime(snap.t0)} → ${fmtTime(snap.t1)}`);
  console.log(`  钱包余额      ${f(first.wallet, 6)}  →  ${f(last.wallet, 6)}   (${sgn(n(last.wallet) - n(first.wallet), 6)} USDC)`);
  console.log(`  当前持仓      ${f(last.position_qty, 1)}  @ mark ${f(last.mark_price, 5)}`);
  console.log(`  可用/保证金   ${f(last.available, 2)} / ${f(last.margin_used, 2)}`);
  line();
}

// ---------- 分组 ----------
const groups = (label, col) => {
  const rows = q(`SELECT ${col} k, COUNT(*) c, SUM(CAST(quote_qty AS REAL)) turnover,
    SUM(CAST(fee AS REAL)) fee, SUM(CAST(realized_pnl AS REAL)) realized
    FROM trades GROUP BY ${col} ORDER BY turnover DESC`);
  if (!rows.length) return;
  console.log(`\n${label}`);
  console.log(`  ${'分组'.padEnd(14)}${'笔数'.padStart(7)}${'成交额'.padStart(14)}${'手续费'.padStart(12)}${'已实现'.padStart(12)}${'净额'.padStart(12)}${'净/额'.padStart(11)}`);
  for (const r of rows) {
    const g = n(r.realized) + feeIncome(r.fee);
    console.log(`  ${String(r.k).padEnd(14)}${String(r.c).padStart(7)}${f(r.turnover, 2).padStart(14)}` +
      `${f(r.fee, 4).padStart(12)}${f(r.realized, 4).padStart(12)}${f(g, 4).padStart(12)}${bps(g, r.turnover).padStart(11)}`);
  }
};
groups('按币种', 'symbol');
groups('按流动性', 'liquidity');
groups('按执行模式', 'execution');

if (argv.includes('--daily')) {
  const rows = q(`SELECT date(trade_time/1000,'unixepoch','localtime') d, COUNT(*) c,
    SUM(CAST(quote_qty AS REAL)) turnover, SUM(CAST(fee AS REAL)) fee, SUM(CAST(realized_pnl AS REAL)) realized
    FROM trades GROUP BY d ORDER BY d`);
  console.log('\n按日汇总');
  console.log(`  ${'日期'.padEnd(14)}${'笔数'.padStart(7)}${'成交额'.padStart(14)}${'手续费'.padStart(12)}${'已实现'.padStart(12)}${'净额'.padStart(12)}${'净/额'.padStart(11)}`);
  for (const r of rows) {
    const g = n(r.realized) + feeIncome(r.fee);
    console.log(`  ${String(r.d).padEnd(14)}${String(r.c).padStart(7)}${f(r.turnover, 2).padStart(14)}` +
      `${f(r.fee, 4).padStart(12)}${f(r.realized, 4).padStart(12)}${f(g, 4).padStart(12)}${bps(g, r.turnover).padStart(11)}`);
  }
}

const recent = Number(arg('--recent', 0));
if (recent > 0) {
  console.log(`\n最近 ${recent} 笔`);
  for (const r of q(`SELECT * FROM trades ORDER BY trade_time DESC LIMIT ?`, recent)) {
    console.log(`  ${fmtTime(r.trade_time)}  ${String(r.symbol).padEnd(9)} ${r.side === 'BUY' ? '买' : '卖'} ` +
      `${f(r.quantity, 1).padStart(8)} @ ${f(r.price, 5)}  费 ${f(r.fee, 6).padStart(10)}  盈亏 ${f(r.realized_pnl, 6).padStart(10)}  ${r.liquidity}`);
  }
}
console.log();
db.close();
