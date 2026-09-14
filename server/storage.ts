import { existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, closeSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { robotSchema, riskSchema } from '../shared/config';
import type { PersistedState } from './engine';
import { D } from './math';

const decimal = z.string().refine(s => { try { return D(s).isFinite(); } catch { return false; } }, '无效的金额或数量');
const nonnegative = decimal.refine(s => D(s).gte(0));
const positive = decimal.refine(s => D(s).gt(0));
const time = z.number().finite().nonnegative();
const robotState = robotSchema.innerType().extend({
  id: z.string().uuid(), createdAt: time, status: z.enum(['paused', 'running', 'cooldown', 'reduce_only']),
  reason: z.string(), cooldownUntil: time, centerPrice: nonnegative, lastRecenterAt: time, lastQuoteAt: time,
  positionQty: decimal, entryPrice: nonnegative, realizedPnl: decimal, fees: decimal, filledNotional: nonnegative,
  fillCount: z.number().int().nonnegative(),
  liveOrderId: z.string().optional(), liveClientOrderId: z.string().optional(),
  lastSyncedAt: time.optional(),
});
const marketState = z.object({
  symbol: z.string(), baseAsset: z.string(), quoteAsset: z.enum(['USDC', 'USDT']),
  priceTick: positive, quantityStep: positive, minQty: positive, maxQty: positive, minNotional: positive,
  bid: positive, ask: positive, bidQty: nonnegative, askQty: nonnegative, markPrice: positive,
  changePercent: z.number().finite(), quoteVolume: z.number().finite().nonnegative(), updatedAt: time,
  history: z.array(z.object({ time, price: z.number().finite().positive() })).max(180),
});
const liveAccountAsset = z.object({
  asset: z.string(), walletBalance: decimal, availableBalance: decimal, unrealizedProfit: decimal,
  marginBalance: decimal,
});
const liveAccountState = z.object({
  totalWalletBalance: decimal, totalUnrealizedProfit: decimal, totalMarginBalance: decimal,
  totalPositionInitialMargin: decimal, totalOpenOrderInitialMargin: decimal,
  availableBalance: decimal, maxWithdrawAmount: decimal,
  assets: z.array(liveAccountAsset), fetchedAt: time,
});
const liveStatusState = z.object({
  environment: z.enum(['demo', 'production']), baseUrl: z.string(),
  configured: z.boolean(), configurationIssue: z.string().nullable(),
  blockedUntil: time, lastWeight: z.number().int().nonnegative(),
  ordersThisMinute: z.number().int().nonnegative(),
  lastSyncedAt: time.nullable(), lastAccountSyncAt: time.nullable(),
  lastAccountError: z.string().nullable(),
});
// Newer schema with execution mode + live fields. Old records that lack the
// execution key are upgraded to 'paper' on read so legacy data continues to
// load without manual migration.
const schema = z.object({
  version: z.literal(1),
  execution: z.enum(['paper', 'live']).default('paper'),
  source: z.enum(['simulation', 'binance']),
  wallets: z.object({ USDT: decimal, USDC: decimal }),
  markets: z.array(marketState), robots: z.array(robotState).max(30),
  fills: z.array(z.object({ id: z.string(), orderId: z.string(), robotId: z.string(), symbol: z.string(),
    side: z.enum(['BUY', 'SELL']), price: positive, quantity: positive, fee: decimal,
    realizedPnl: decimal, time, liquidity: z.enum(['MAKER', 'TAKER']),
    execution: z.enum(['SIMULATED', 'LIVE']), tradeId: z.string().optional() })).max(2000),
  events: z.array(z.object({ id: z.string(), time, level: z.enum(['info', 'warning', 'critical']),
    category: z.enum(['system', 'order', 'risk', 'robot', 'live']),
    message: z.string(), robotId: z.string().optional(), symbol: z.string().optional() })).max(600),
  settings: riskSchema, emergencyStopped: z.boolean(), stopReason: z.string(), day: z.string(),
  dailyStartEquity: decimal, peakEquity: decimal, totalFees: decimal, totalFilledNotional: nonnegative,
  liveAccount: liveAccountState.nullable().default(null),
  liveStatus: liveStatusState.nullable().default(null),
});
// Legacy schema used only to bootstrap a record that predates execution tracking.
const legacySchema = schema.omit({ execution: true, liveAccount: true, liveStatus: true }).extend({
  fills: schema.shape.fills.element.omit({ liquidity: true }).extend({
    liquidity: z.literal('MAKER').default('MAKER'),
  }),
  events: schema.shape.events.element.omit({ category: true }).extend({
    category: z.enum(['system', 'order', 'risk', 'robot']),
  }),
});

export class StateStore {
  private filename: string;
  private lockfile: string;
  private lastGood = '';
  recovered = false;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.filename = path.join(directory, 'state.json');
    this.lockfile = path.join(directory, 'runtime.lock');
    if (existsSync(this.lockfile)) {
      const pid = Number(readFileSync(this.lockfile, 'utf8'));
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') alive = true;
        }
      }
      if (alive) throw new Error(`模拟数据目录正被进程 ${pid} 使用，请勿启动第二个写入实例`);
      unlinkSync(this.lockfile);
    }
    const fd = openSync(this.lockfile, 'wx');
    writeFileSync(fd, String(process.pid)); closeSync(fd);
  }

  read(): PersistedState | undefined {
    if (!existsSync(this.filename)) {
      if (!existsSync(`${this.filename}.bak`)) return undefined;
    }
    for (const filename of [this.filename, `${this.filename}.bak`]) {
      try {
        const text = readFileSync(filename, 'utf8');
        const raw = JSON.parse(text);
        const data = schema.parse(raw);
        if (new Set(data.robots.map(r => r.symbol)).size !== data.robots.length) throw new Error('同合约存在重复机器人');
        this.lastGood = text;
        this.recovered = filename.endsWith('.bak');
        return data;
      } catch (primaryError) {
        try {
          const text = readFileSync(filename, 'utf8');
          const raw = JSON.parse(text);
          const legacy = legacySchema.parse(raw);
          const data = schema.parse({ ...legacy, execution: 'paper', liveAccount: null, liveStatus: null });
          if (new Set(data.robots.map(r => r.symbol)).size !== data.robots.length) throw primaryError;
          this.lastGood = text;
          this.recovered = filename.endsWith('.bak');
          return data;
        } catch { /* Try the validated backup; never silently reset a damaged account. */ }
      }
    }
    this.release();
    throw new Error('模拟账户文件与备份均无法验证；为保护记录，已停止启动。请保留 data 目录排查。');
  }

  save(state: PersistedState) {
    const content = JSON.stringify(schema.parse(state));
    const temporary = `${this.filename}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    if (this.lastGood) {
      const backupTemp = `${this.filename}.bak.tmp`;
      writeFileSync(backupTemp, this.lastGood, { mode: 0o600 });
      renameSync(backupTemp, `${this.filename}.bak`);
    }
    renameSync(temporary, this.filename);
    this.lastGood = content;
  }

  release() {
    try {
      if (readFileSync(this.lockfile, 'utf8') === String(process.pid)) unlinkSync(this.lockfile);
    } catch { /* The process lock may already have been released. */ }
  }
}
