import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ConnectionAccount, ConnectionCheck, ConnectionReport, ConnectionStatus } from '../shared/connection';
import { BinanceReadError, BinanceReadOnlyClient, symbolSchema } from './binance-readonly';
import { parseInstruments } from './markets';
import { D } from './math';

const decimal = z.string().refine(s => { try { return D(s).isFinite(); } catch { return false; } });
const accountSchema = z.object({ assets: z.array(z.object({ asset: z.string(), walletBalance: decimal, availableBalance: decimal, unrealizedProfit: decimal })) });
const positionsSchema = z.array(z.object({ symbol: z.string(), positionSide: z.enum(['BOTH', 'LONG', 'SHORT']), positionAmt: decimal, entryPrice: decimal, markPrice: decimal, liquidationPrice: decimal }));
const commissionSchema = z.object({ symbol: z.string(), makerCommissionRate: decimal, takerCommissionRate: decimal });
const snapshotTime = z.number().int().positive();
const bookSchema = z.object({ symbol: z.string(), bidPrice: decimal, askPrice: decimal, time: snapshotTime });
const markSchema = z.object({ symbol: z.string(), markPrice: decimal, time: snapshotTime });

export class ConnectionInspector {
  #running = false;
  #nextCheckAt = 0;
  #report: ConnectionReport | null = null;
  #completion: Promise<void> = Promise.resolve();
  constructor(private readonly client: BinanceReadOnlyClient, private readonly now = Date.now) {}

  status(): ConnectionStatus {
    return { environment: this.client.environment, baseUrl: this.client.baseUrl,
      credentialsConfigured: this.client.configured, configurationIssue: this.client.configurationIssue,
      running: this.#running, nextCheckAt: Math.max(this.#nextCheckAt, this.client.blockedUntil),
      lastReport: this.#report, execution: 'read-only' };
  }

  start(symbol: string, includeAccount: boolean) {
    symbolSchema.parse(symbol);
    if (this.#running) throw new Error('连接检查正在进行，请等待当前结果');
    if (this.now() < this.status().nextCheckAt) throw new Error('距离上次检查过近，或接口正在退避，请稍后再试');
    this.#running = true; this.#nextCheckAt = this.now() + 30000;
    this.#report = { id: randomUUID(), environment: this.client.environment, symbol, startedAt: this.now(), finishedAt: null,
      publicDataVerified: false, accountReadVerified: false, liveTradingAvailable: false, checks: [] };
    this.#completion = this.#run(this.#report, includeAccount).catch(() => {
      this.#report!.checks.push({ id: 'unexpected', label: '检查完成状态', status: 'failed', detail: '检查未完整完成，不能据此认定连接已通过' });
    }).finally(() => {
      this.#running = false;
      this.#report!.finishedAt = this.now();
      this.#nextCheckAt = Math.max(this.#nextCheckAt, this.client.blockedUntil);
    });
    return this.status();
  }

  async waitForCompletion() { await this.#completion; return this.status(); }

  async #run(report: ConnectionReport, includeAccount: boolean) {
    const add = (id: string, label: string, status: ConnectionCheck['status'], detail: string) => report.checks.push({ id, label, status, detail });
    const fail = (id: string, label: string, error: unknown) => add(id, label, 'failed', error instanceof BinanceReadError ? error.message : '响应结构与预期不符，未采纳该结果');
    // This result always remains explicit, even if every read-only check succeeds.
    add('execution', '实盘订单执行', 'not_implemented', '未实现实盘下单、撤单或平仓；只读认证成功不等于可实盘交易');
    let clockOk = false;
    try {
      report.clock = await this.client.synchronizeClock(); clockOk = true;
      add('clock', '网络与服务器时钟', Math.abs(report.clock.offsetMs) > 1000 || report.clock.roundTripMs > 1500 ? 'warning' : 'passed',
        `往返 ${report.clock.roundTripMs} ms，本机偏差 ${report.clock.offsetMs} ms；签名查询使用校准时间`);
    } catch (error) { fail('clock', '网络与服务器时钟', error); }
    let instrument: ReturnType<typeof parseInstruments>[number] | undefined;
    if (clockOk) {
      try {
        instrument = parseInstruments(await this.client.publicData('exchangeInfo')).find(i => i.symbol === report.symbol);
        if (!instrument) throw new BinanceReadError('SYMBOL_UNAVAILABLE', `${report.symbol} 不在该环境可用的 U 本位永续合约中`);
        add('instrument', '合约状态与下单单位', 'passed', `${instrument.symbol}：价格步长 ${instrument.priceTick}，数量步长 ${instrument.quantityStep}，最小名义金额 ${instrument.minNotional} ${instrument.quoteAsset}`);
      } catch (error) { fail('instrument', '合约状态与下单单位', error); }
    } else add('instrument', '合约状态与下单单位', 'skipped', '连接或时钟未通过，未继续请求');
    if (instrument) {
      try {
        const book = bookSchema.parse(await this.client.publicData('bookTicker', report.symbol));
        const mark = markSchema.parse(await this.client.publicData('premiumIndex', report.symbol));
        if (book.symbol !== report.symbol || mark.symbol !== report.symbol || !D(book.bidPrice).gt(0) || !D(book.askPrice).gt(book.bidPrice) || !D(mark.markPrice).gt(0)) {
          throw new BinanceReadError('BAD_MARKET', '盘口或标记价无效，不能用于策略报价');
        }
        const serverNow = this.now() + (report.clock?.offsetMs ?? 0);
        if ([book.time, mark.time].some(time => serverNow - time > 8000 || time > serverNow + 1000)) {
          throw new BinanceReadError('STALE_MARKET', '行情快照已经过期或时间戳异常');
        }
        report.publicDataVerified = true;
        add('market', '盘口与标记价格', 'passed', `买一 ${book.bidPrice} / 卖一 ${book.askPrice}，标记价 ${mark.markPrice}；仅验证当前快照`);
      } catch (error) { fail('market', '盘口与标记价格', error); }
    } else add('market', '盘口与标记价格', 'skipped', '合约规则未通过，未继续请求');

    let account: ConnectionAccount | undefined;
    if (!includeAccount) add('account', '账户只读认证', 'skipped', '本次只检查公开数据，未请求账户信息');
    else if (!this.client.configured) add('account', '账户只读认证', 'skipped', this.client.configurationIssue ?? '服务端尚未配置专用只读 HMAC Key / Secret');
    else if (!clockOk) add('account', '账户只读认证', 'skipped', '连接或时钟检查失败，未发送带凭据的请求');
    else {
      try {
        const result = accountSchema.parse(await this.client.accountData('account'));
        account = { assets: result.assets.filter(a => ['USDT', 'USDC'].includes(a.asset)) };
        report.account = account; report.accountReadVerified = true;
        add('account', '账户只读认证', 'passed', '账户数据已读取；没有验证下单权限，也没有向账户发送订单');
      } catch (error) { fail('account', '账户只读认证', error); }
    }
    if (account) {
      try {
        const result = z.object({ dualSidePosition: z.boolean() }).parse(await this.client.accountData('positionMode'));
        account.hedgeMode = result.dualSidePosition;
        add('positionMode', '持仓模式', result.dualSidePosition ? 'warning' : 'passed', result.dualSidePosition ? '账户为双向持仓，不能套用当前模拟器的单向净持仓模型' : '账户为单向持仓；只读取，未修改');
      } catch (error) { fail('positionMode', '持仓模式', error); }
      try {
        const result = z.object({ multiAssetsMargin: z.boolean() }).parse(await this.client.accountData('multiAssets'));
        account.multiAssetsMargin = result.multiAssetsMargin;
        add('marginMode', '保证金账户模式', result.multiAssetsMargin ? 'warning' : 'passed', result.multiAssetsMargin ? '账户启用多资产保证金，当前独立 USDT/USDC 模拟预算不能代表真实可用保证金' : '账户为单资产保证金模式；余额只展示，不导入模拟账户');
      } catch (error) { fail('marginMode', '保证金账户模式', error); }
      try {
        account.positions = positionsSchema.parse(await this.client.accountData('positions')).filter(p => !D(p.positionAmt).isZero()).map(p => ({
          symbol: p.symbol, positionSide: p.positionSide, quantity: p.positionAmt, entryPrice: p.entryPrice, markPrice: p.markPrice, liquidationPrice: p.liquidationPrice,
        }));
        add('positions', '真实持仓读取', account.positions.length ? 'warning' : 'passed', account.positions.length ? `读取到 ${account.positions.length} 条非零持仓，本工具不接管或更改这些仓位` : '当前查询没有非零持仓；不代表后续账户状态');
      } catch (error) { fail('positions', '真实持仓读取', error); }
      if (instrument) {
        try {
          const result = commissionSchema.parse(await this.client.accountData('commission', report.symbol));
          if (result.symbol !== report.symbol) throw new Error('Symbol mismatch');
          account.makerFeeRate = result.makerCommissionRate; account.takerFeeRate = result.takerCommissionRate;
          add('fees', '实际账户手续费', 'passed', `Maker ${D(result.makerCommissionRate).mul(10000).toFixed()} bps / Taker ${D(result.takerCommissionRate).mul(10000).toFixed()} bps；未修改模拟参数`);
        } catch (error) { fail('fees', '实际账户手续费', error); }
      } else add('fees', '实际账户手续费', 'skipped', '所选合约未验证，不请求该合约费率');
    } else {
      for (const [id, label] of [['positionMode', '持仓模式'], ['marginMode', '保证金账户模式'], ['positions', '真实持仓读取'], ['fees', '实际账户手续费']]) {
        add(id, label, 'skipped', '尚未取得经过认证的账户快照');
      }
    }
  }
}
