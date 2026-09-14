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
  shockPercent: z.number().finite().min(0.1).max(10),
  cooldownSeconds: z.number().int().min(10).max(86400),
  makerFeeBps: z.number().finite().min(0).max(100),
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
}).strict();

export const defaultRisk: RiskSettings = {
  maxGrossNotional: 15000,
  maxMarginPercent: 40,
  dailyLossLimit: 400,
  maxDrawdownPercent: 5,
  staleAfterSeconds: 8,
  maxActionsPerMinute: 180,
};

export function defaultConfig(instrument: Instrument): RobotConfig {
  const base = instrument.baseAsset;
  const orderSize = base === 'BTC' ? 120 : base === 'ETH' ? 90 : 60;
  return {
    name: `${base} 移动网格`, symbol: instrument.symbol,
    sizingMode: 'quote', orderSize, contractSize: Number(instrument.quantityStep),
    gridCount: 12, rangeMode: 'bps', halfRange: 60,
    recenterMinutes: 30, repriceSeconds: 15, orderTtlSeconds: 1800,
    closeOffsetMode: 'bps', closeLongOffset: 1, closeShortOffset: 1, leverage: 3, maxPositionNotional: 2000,
    maxOpenNotional: 2000, maxOrderNotional: 300,
    stopLossQuote: 80, shockPercent: 1, cooldownSeconds: 60, makerFeeBps: 2,
  };
}
