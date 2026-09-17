import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { D } from './math';

/**
 * 成交记录的独立持久化。
 *
 * 为什么不复用 state.json：那里的 fills 有 2000 条上限、每 5 秒全量重写整个账户状态，
 * 且与账户数据混在一个文件里，既不可查询、又会被重置/损坏连带丢失。
 * 这里用 SQLite 追加写，WAL 模式，机器人运行时可以并发读取做分析。
 */

export interface TradeRecord {
  id: string; orderId: string; robotId: string; symbol: string;
  side: 'BUY' | 'SELL'; price: string; quantity: string;
  fee: string; realizedPnl: string; time: number;
  liquidity: 'MAKER' | 'TAKER'; execution: 'SIMULATED' | 'LIVE';
  tradeId?: string;
}

export interface EquitySnapshot {
  ts: number; wallet: string; available: string; unrealized: string;
  marginUsed: string; positionQty: string; markPrice: string; execution: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id           TEXT PRIMARY KEY,
  trade_id     TEXT,
  order_id     TEXT,
  robot_id     TEXT,
  robot_name   TEXT,
  symbol       TEXT NOT NULL,
  side         TEXT NOT NULL,
  price        TEXT NOT NULL,
  quantity     TEXT NOT NULL,
  quote_qty    TEXT,
  fee          TEXT,
  realized_pnl TEXT,
  liquidity    TEXT,
  execution    TEXT,
  trade_time   INTEGER NOT NULL,
  logged_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_time   ON trades(trade_time);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol, trade_time);
CREATE INDEX IF NOT EXISTS idx_trades_liq    ON trades(liquidity, trade_time);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  ts           INTEGER PRIMARY KEY,
  wallet       TEXT, available TEXT, unrealized TEXT,
  margin_used  TEXT, position_qty TEXT, mark_price TEXT, execution TEXT
);
`;

export interface TradeLogStats { trades: number; snapshots: number; file: string }

export class TradeLog {
  #db: DatabaseSync;
  #insert: ReturnType<DatabaseSync['prepare']>;
  #snapshot: ReturnType<DatabaseSync['prepare']>;
  #robotNames = new Map<string, string>();
  file: string;
  #closed = false;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.#db = new DatabaseSync(file);
    // WAL：崩溃安全，且允许机器人运行时并发查询
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(SCHEMA);
    this.#insert = this.#db.prepare(`
      INSERT OR IGNORE INTO trades
        (id, trade_id, order_id, robot_id, robot_name, symbol, side, price, quantity,
         quote_qty, fee, realized_pnl, liquidity, execution, trade_time, logged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.#snapshot = this.#db.prepare(`
      INSERT OR REPLACE INTO equity_snapshots
        (ts, wallet, available, unrealized, margin_used, position_qty, mark_price, execution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  }

  setRobotName(robotId: string, name: string): void { this.#robotNames.set(robotId, name); }

  /** 写入一笔成交。返回 false 表示这条记录已存在（按 id 去重）。 */
  record(t: TradeRecord): boolean {
    if (this.#closed) return false;
    const result = this.#insert.run(
      t.id, t.tradeId ?? null, t.orderId, t.robotId,
      this.#robotNames.get(t.robotId) ?? null,
      t.symbol, t.side, t.price, t.quantity,
      D(t.price).mul(t.quantity).toFixed(), t.fee, t.realizedPnl,
      t.liquidity, t.execution, t.time, Date.now(),
    );
    return Number(result.changes) > 0;
  }

  recordEquity(s: EquitySnapshot): void {
    if (this.#closed) return;
    this.#snapshot.run(s.ts, s.wallet, s.available, s.unrealized,
      s.marginUsed, s.positionQty, s.markPrice, s.execution);
  }

  stats(): TradeLogStats {
    const t = this.#db.prepare('SELECT COUNT(*) AS n FROM trades').get() as { n: number };
    const s = this.#db.prepare('SELECT COUNT(*) AS n FROM equity_snapshots').get() as { n: number };
    return { trades: t.n, snapshots: s.n, file: this.file };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db.close(); } catch { /* 关闭失败不应阻断退出流程 */ }
  }
}
