// AI 策略指挥官（量化决策层）
// 职责：
//   1) 组装"市场摘要"（K线摘要 + 币安公告 + 可选联网搜索）→ system/user prompt
//   2) 调用 LLM(DeepSeek) 获取结构化 JSON 调参建议 {symbol, adjustments, reason}
//   3) guardrail 校验：白名单字段 + schema 边界 + 单次相对幅度 ±50% + 交叉约束
//   4) 产出 AiAdjustment，由调用方应用（engine.applyLiveParams）并落库审计
// 安全约束：
//   - AI 只能改白名单字段；资金/仓位/费率敏感字段禁止
//   - 校验失败/解析失败 → reject（绝不透传未经验证的值）
//   - LLM/搜索不可用 → 静默降级，返回 null，不影响引擎主循环

import { z } from 'zod';
import type { KlineSummary } from './klines';
import type { NewsItem } from './info-news';
import type { SearchClient } from './web-search';
import type { Robot } from '../shared/types';

// ===== 白名单：AI 允许调整的字段（资金/杠杆/仓位/费率一律禁止） =====
export const AI_ALLOWED_FIELDS = [
  'halfRange',
  'orderSize',
  'gridCount',
  'repriceSeconds',
  'orderTtlSeconds',
  'shockPercent',
  'inventorySkew',
  'recenterMinutes',
  'stopLossPercent',
] as const;

export type AiAllowedField = (typeof AI_ALLOWED_FIELDS)[number];

// ===== schema 边界（与 shared/config.ts 保持一致，防护时使用） =====
export const AI_FIELD_BOUNDS: Record<AiAllowedField, { min: number; max: number; int?: boolean }> = {
  halfRange: { min: 0.000001, max: 1e8 },
  orderSize: { min: 0.01, max: 1e8 },
  gridCount: { min: 2, max: 60, int: true },
  repriceSeconds: { min: 5, max: 3600, int: true },
  orderTtlSeconds: { min: 10, max: 86400, int: true },
  shockPercent: { min: 0.1, max: 10 },
  inventorySkew: { min: 0, max: 2 },
  recenterMinutes: { min: 1, max: 1440, int: true },
  stopLossPercent: { min: 0, max: 100 },
};

/** 单次相对调整幅度上限（如 ±50%：新值 ∈ [旧值×0.5, 旧值×1.5]） */
export const AI_MAX_RELATIVE_CHANGE = 0.5;

// ===== 建议产出 =====
export interface AiAdjustment {
  symbol: string;
  adjustments: Partial<Record<AiAllowedField, number>>;
  reason: string;
}

export interface ValidatedAdjustment extends AiAdjustment {
  /** 采纳后机器人的完整白名单字段（已合并、已 clamp、已过边界） */
  after: Partial<Record<AiAllowedField, number>>;
}

// prompt 中注入给 LLM 的市场摘要
export interface AiContext {
  symbol: string;
  klines: KlineSummary[];
  news: NewsItem[];
  search?: { query: string; results: { title: string; url: string; snippet: string }[] };
  robot: Pick<Robot, 'name' | 'status' | 'positionQty' | 'realizedPnl' | 'fees'>;
  /** 账户概况（equity/使用保证金等），字符串形式由调用方拼好 */
  accountSummary: string;
}

// ===== guardrail =====

export interface GuardResult {
  ok: boolean;
  validated?: ValidatedAdjustment;
  rejectReason?: string;
}

/**
 * 校验并修正 AI 建议：
 * 1) 只允许白名单字段
 * 2) 数值过 schema 边界 → 拒绝（不静默修改，防止 LLM 幻觉值溜进）
 * 3) 单次相对幅度超 ±50% → 拒绝
 * 4) 交叉约束（orderTtl >= repriceSeconds）→ 拒绝冲突
 */
export function guardAiAdjustment(robot: Robot, raw: unknown): GuardResult {
  if (!raw || typeof raw !== 'object') return { ok: false, rejectReason: '建议不是有效对象' };
  const obj = raw as Record<string, unknown>;
  const symbol = String(obj.symbol ?? '');
  if (!symbol || symbol !== robot.symbol) return { ok: false, rejectReason: `交易对不匹配（期望 ${robot.symbol}）` };
  if (typeof obj.adjustments !== 'object' || obj.adjustments === null) {
    return { ok: false, rejectReason: '缺少 adjustments' };
  }
  const reason = String(obj.reason ?? '').trim();
  if (!reason) return { ok: false, rejectReason: '缺少 reason（AI 必须说明理由）' };

  const incoming = obj.adjustments as Record<string, unknown>;
  const adjustments: AiAdjustment['adjustments'] = {};
  const after: ValidatedAdjustment['after'] = {};

  for (const [key, value] of Object.entries(incoming)) {
    if (!(AI_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, rejectReason: `字段 ${key} 不在 AI 白名单内` };
    }
    const field = key as AiAllowedField;
    const bound = AI_FIELD_BOUNDS[field];
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false, rejectReason: `字段 ${field} 不是有限数字` };
    if (bound.int && !Number.isInteger(num)) return { ok: false, rejectReason: `字段 ${field} 必须为整数` };
    if (num < bound.min || num > bound.max) {
      return { ok: false, rejectReason: `字段 ${field} 超出允许范围 ${bound.min}~${bound.max}` };
    }
    const current = Number(robot[field] ?? 0);
    if (current > 0) {
      const ratio = Math.abs(num - current) / current;
      if (ratio > AI_MAX_RELATIVE_CHANGE) {
        return { ok: false, rejectReason: `字段 ${field} 单次调整幅度 ${(ratio * 100).toFixed(1)}% 超过上限 ${AI_MAX_RELATIVE_CHANGE * 100}%` };
      }
    }
    adjustments[field] = num;
    after[field] = num;
  }

  if (Object.keys(adjustments).length === 0) return { ok: false, rejectReason: 'adjustments 为空' };

  // 交叉约束：orderTtlSeconds 不能小于 repriceSeconds
  const finalReprice: number | undefined = after.repriceSeconds ?? Number(robot.repriceSeconds);
  const finalTtl: number | undefined = after.orderTtlSeconds ?? Number(robot.orderTtlSeconds);
  if (finalTtl !== undefined && finalReprice !== undefined && finalTtl < finalReprice) {
    return { ok: false, rejectReason: `orderTtlSeconds(${finalTtl}) 不能小于 repriceSeconds(${finalReprice})` };
  }

  return { ok: true, validated: { symbol, adjustments, reason, after } };
}

// ===== prompt 组装 =====

export interface PromptFragments {
  system: string;
  user: string;
}

export function buildAiPrompt(ctx: AiContext): PromptFragments {
  const klineLines = ctx.klines.length
    ? ctx.klines.map((k) => `[${k.interval}] 收盘 ${k.lastPrice} 本周期 ${k.changePct.toFixed(3)}% 上周期 ${k.prevChangePct.toFixed(3)}% 24h高 ${k.high24} 低 ${k.low24} 振幅 ${k.amplitudePct.toFixed(2)}% 均量 ${Math.round(k.avgVolume)} 趋势 ${k.trend === 1 ? '↑' : k.trend === -1 ? '↓' : '→'}`).join('\n')
    : '（暂无K线数据）';

  const newsLines = ctx.news.length
    ? ctx.news.map((n) => `- ${n.title}`).join('\n')
    : '（暂无公告）';

  const searchLines = ctx.search?.results.length
    ? ctx.search.results.map((r) => `- [${r.title}](${r.url}) ${r.snippet.slice(0, 140)}`).join('\n')
    : '（搜索未配置或无结果）';

  const system = [
    '你是一个加密货币 Maker 网格交易机器人的"策略指挥官"。',
    '交易逻辑：机器人以最新价为网格中心双向挂 Post-Only 限价单（吃 Maker 返佣+价差），你有权在安全范围内调整网格参数以适配市场状态。',
    '市场状态判断：趋势强 → 可放宽 halfRange / 减少 gridCount（少而宽）；震荡 → 收窄 halfRange / 加密 gridCount（多而密）；波动率剧增 → 提高 shockPercent 熔断阈值或减少开仓；单边下跌导致库存积压 → 提高 inventorySkew 促进减仓。',
    '你只能输出一个 JSON 对象，格式：{"symbol":"...","adjustments":{"字段名":数值},"reason":"中文说明"}。',
    `允许调整的字段（只允许这些，出现其它字段视为违规）：${AI_ALLOWED_FIELDS.join(', ')}。`,
    '约束：每次只允许在现有值基础上调整 ±50% 以内；gridCount 必须为偶数；orderTtlSeconds 必须 ≥ repriceSeconds；reason 必须用中文解释你的判断依据。',
    '如果你认为当前参数合适，adjustments 里可以置 {}，但理由仍需说明。',
    '禁止臆造数据，只依据提供的信息。',
  ].join('\n');

  const user = [
    `交易对：${ctx.symbol}`,
    `机器人：${ctx.robot.name} | 状态 ${ctx.robot.status} | 持仓 ${ctx.robot.positionQty} | 已实现盈亏 ${ctx.robot.realizedPnl} | 累计费用 ${ctx.robot.fees}`,
    `账户概况：${ctx.accountSummary}`,
    '',
    `【K线摘要】\n${klineLines}`,
    '',
    `【币安官方公告（近几条）】\n${newsLines}`,
    '',
    `【联网搜索（可选补充）】\n${searchLines}`,
    '',
    '请按预定 JSON 格式输出你的调参建议。',
  ].join('\n');

  return { system, user };
}

// ===== 解析 LLM 输出 =====

const suggestionSchema = z.object({
  symbol: z.string(),
  adjustments: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().default(''),
});

export function parseLlmSuggestion(content: string): unknown | null {
  const trimmed = content.trim();
  // 容错：剥掉可能包裹的 ```json ... ``` 或首尾杂文案
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = suggestionSchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ===== 指挥官编排（注入依赖，便于测试） =====

export interface CommanderDeps {
  llm: { chat(messages: { role: 'system' | 'user'; content: string }[]): Promise<string> };
  search?: SearchClient;
  /** 每次决策前可选的联网搜索查询构造（按需返回 null 表示跳过搜索） */
  searchQueryBuilder?: (ctx: { symbol: string; klines: KlineSummary[] }) => string | null;
}

export interface AiDecision {
  adjustment: ValidatedAdjustment | null;
  rejected?: { reason: string; raw: unknown };
  /** 决策时长 ms */
  elapsedMs: number;
  at: number;
}

/** 单次决策：context → prompt → LLM → 搜索(可选) → 解析 → guardrail */
export async function runCommanderDecision(
  ctx: AiContext,
  robot: Robot,
  deps: CommanderDeps,
  at = Date.now(),
): Promise<AiDecision | null> {
  if (deps.search && deps.searchQueryBuilder) {
    const q = deps.searchQueryBuilder({ symbol: ctx.symbol, klines: ctx.klines });
    if (q) {
      try {
        const results = await deps.search.search(q, { max: 4 });
        ctx = { ...ctx, search: { query: q, results } };
      } catch {
        ctx = ctx; // 搜索失败不影响决策
      }
    }
  }
  const { system, user } = buildAiPrompt(ctx);
  const started = Date.now();
  try {
    const content = await deps.llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }]);
    const raw = parseLlmSuggestion(content);
    if (raw === null) {
      return { adjustment: null, rejected: { reason: 'LLM 输出不是合法 JSON', raw: content }, elapsedMs: Date.now() - started, at };
    }
    const result = guardAiAdjustment(robot, raw);
    if (!result.ok || !result.validated) {
      return { adjustment: null, rejected: { reason: result.rejectReason ?? 'guardrail 拒绝', raw }, elapsedMs: Date.now() - started, at };
    }
    return { adjustment: result.validated, elapsedMs: Date.now() - started, at };
  } catch (error) {
    return { adjustment: null, rejected: { reason: error instanceof Error ? error.message : 'LLM 调用失败', raw: String(error) }, elapsedMs: Date.now() - started, at };
  }
}