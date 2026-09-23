import { z } from 'zod';
import type { Instrument, RiskSettings, RobotConfig } from './types';

export const robotSchema = z.object({
  name: z.string().trim().min(1, '请填写机器人名称').max(40),
  symbol: z.string().regex(/^[A-Z0-9]{3,30}$/),
  sizingMode: z.enum(['quote', 'base', 'contracts', 'equity_pct', 'available_pct']),
  orderSize: z.number().finite().positive().max(1e8),
  contractSize: z.number().finite().positive().max(1e8),
  gridCount: z.number().int().min(2).max(60).refine(n => n % 2 === 0, '网格数量必须为偶数，两侧各一半'),
  rangeMode: z.enum(['fixed', 'bps']),
  halfRange: z.number().finite().positive().max(1e8),
  recenterMinutes: z.number().int().min(1).max(1440),
  repriceSeconds: z.number().int().min(5).max(3600),
  orderTtlSeconds: z.number().int().min(10).max(86400),
  closeOffsetMode: z.enum(['fixed', 'bps']),
  closeLongOffset: z.number().finite().min(0).max(1e8),
  closeShortOffset: z.number().finite().min(0).max(1e8),
  leverage: z.number().int().min(1).max(20),
  maxPositionNotional: z.number().finite().min(5).max(1e7),
  maxOpenNotional: z.number().finite().min(5).max(1e7),
  maxOrderNotional: z.number().finite().min(5).max(1e6),
  stopLossQuote: z.number().finite().positive().max(1e6),
  // 止损的「按仓位比例」阈值（占持仓名义额的百分比）。与 stopLossQuote 取小值生效。
  // stopLossQuote 是绝对额，仓位上限却是 80 USDC 量级，两者比例决定了需要多大的行情才会触发——
  // 实测 15 USDC 的绝对止损要行情走 19%~75%，一整天 0 次，等于没有止损。
  // 默认 3：持仓 64 USDC 时阈值 1.92 USDC，对应约 3% 的行情。
  stopLossPercent: z.number().finite().min(0).max(100).default(3),
  shockPercent: z.number().finite().min(0.1).max(10),
  cooldownSeconds: z.number().int().min(10).max(86400),
  makerFeeBps: z.number().finite().min(0).max(100),
  // 库存偏斜系数。0 = 关闭（网格以中心价对称挂单，不看持仓）。
  // 值越大，持仓偏离零时中心价往「减仓方向」偏得越多；1 = 满仓时偏移整段单边半区间。
  // 用 .default(0) 保证旧的持久化数据能继续加载。
  inventorySkew: z.number().finite().min(0).max(2).default(0),
  // 只减仓超时（秒）。0 = 关闭（保持纯 Maker 语义）。
  // 单边行情里 Maker 减仓单挂不出去：卖单必须挂在卖一或更高，价格一路跌就一直追在盘口上方，
  // 撤单重挂还不断丢失排位——实测 8 分钟 0 成交，最终裸仓 6.9 小时亏 5.56 U。
  // 设为正数后，只减仓持续超过该时长仍没平掉，就改为挂跨价限价单，用一次 taker 费换取一定成交。
  exitTimeoutSeconds: z.number().int().min(0).max(86400).default(0),
}).strict().superRefine((config, ctx) => {
  if (config.sizingMode.endsWith('_pct') && config.orderSize > 10) {
    ctx.addIssue({ code: 'custom', path: ['orderSize'], message: '每格占比不能超过 10%' });
  }
  if (config.orderTtlSeconds < config.repriceSeconds) {
    ctx.addIssue({ code: 'custom', path: ['orderTtlSeconds'], message: '挂单有效期不能短于最小重报间隔' });
  }
  if (config.rangeMode === 'bps' && config.halfRange > 2000) {
    ctx.addIssue({ code: 'custom', path: ['halfRange'], message: '半区间不能超过 2000 bps（20%）' });
  }
  if (config.closeOffsetMode === 'bps' && (config.closeLongOffset > 100 || config.closeShortOffset > 100)) {
    ctx.addIssue({ code: 'custom', path: ['closeLongOffset'], message: '比例减仓偏移不能超过 100 bps（1%）' });
  }
  if (config.maxOrderNotional > config.maxOpenNotional || config.maxOrderNotional > config.maxPositionNotional) {
    ctx.addIssue({ code: 'custom', path: ['maxOrderNotional'], message: '单笔上限不能超过挂单或持仓上限' });
  }
});

export const riskSchema = z.object({
  maxGrossNotional: z.number().finite().min(100).max(1e7),
  maxMarginPercent: z.number().finite().min(1).max(80),
  dailyLossLimit: z.number().finite().min(1).max(1e6),
  maxDrawdownPercent: z.number().finite().min(0.1).max(30),
  staleAfterSeconds: z.number().int().min(3).max(30),
  maxActionsPerMinute: z.number().int().min(20).max(600),
  // 全局熔断后是否自动平仓。false = 保留持仓交人工复核（作者原设计，避免自动卖在浮亏低点）；
  // true = 有持仓的机器人转入只减仓把仓位平掉。
  // 实测「保留持仓」的代价：熔断后裸仓无人管理 6.9 小时，行情 -8%，亏损从 -0.6 扩大到 -5.56。
  flattenOnStop: z.boolean().default(false),
}).strict();

export const defaultRisk: RiskSettings = {
  maxGrossNotional: 15000,
  maxMarginPercent: 40,
  dailyLossLimit: 400,
  maxDrawdownPercent: 5,
  staleAfterSeconds: 8,
  maxActionsPerMinute: 180,
  flattenOnStop: false,
};

export function defaultConfig(instrument: Instrument): RobotConfig {
  const base = instrument.baseAsset;
  const orderSize = base === 'BTC' ? 120 : base === 'ETH' ? 90 : 60;
  return {
    name: `${base} 移动网格`, symbol: instrument.symbol,
    sizingMode: 'quote', orderSize, contractSize: Number(instrument.quantityStep),
    gridCount: 12, rangeMode: 'bps', halfRange: 120,
    recenterMinutes: 30, repriceSeconds: 15, orderTtlSeconds: 1800,
    closeOffsetMode: 'bps', closeLongOffset: 1, closeShortOffset: 1, leverage: 3, maxPositionNotional: 2000,
    maxOpenNotional: 2000, maxOrderNotional: 300,
    stopLossQuote: 80, shockPercent: 1, cooldownSeconds: 60, makerFeeBps: 0.5, inventorySkew: 0, stopLossPercent: 3,
    exitTimeoutSeconds: 600,
  };
}
