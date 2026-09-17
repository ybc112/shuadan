// AI 指挥官运行器：把 M1 数据层（klines/news/search）与 M2 决策（commander）和
// 执行引擎（applyLiveParams）串成定时闭环。全部故障静默降级，绝不影响引擎主循环。
//
// 配置项（.env）：
//   AI_ADMIN_ENABLED=true 时启用（默认关闭）
//   LLM_BASE_URL / LLM_API_KEY / LLM_MODEL   （DeepSeek 默认）
//   LLM_INTERVAL_MIN=45                       决策周期（分钟）
//   SEARCH_PROVIDER=tavily|bocha  + TAVILY_API_KEY / BOCHA_API_KEY
//   AI_SYMBOLS=可选：只对指定交易对出建议（默认对所有 running 机器人）

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { KlineCollector } from './klines';
import { NewsCollector } from './info-news';
import { LlmClient, llmConfigured } from './llm-client';
import { makeSearchClient } from './web-search';
import { guardAiAdjustment, parseLlmSuggestion, AI_ALLOWED_FIELDS } from './commander';
import type { MakerEngine } from './engine';
import type { KlineSummary } from './klines';
import type { NewsItem } from './info-news';
import type { Robot } from '../shared/types';

export type AiRunnerConfig = {
  engine: MakerEngine;
  klines: KlineCollector;
  news: NewsCollector;
  llm: LlmClient;
  search: ReturnType<typeof makeSearchClient>;
  dataDir: string;
  intervalMinutes: number;
  enabled: boolean;
  searchProvider: string;
  symbols?: string[];
};

export interface AiRunnerStatus {
  enabled: boolean;
  llmConfigured: boolean;
  searchProvider: string;
  lastRunAt: number;
  lastResult: string;
  totalDecisions: number;
  totalApplied: number;
  totalRejected: number;
}

export class AiRunner {
  readonly status: AiRunnerStatus;
  private historyFile: string;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private cfg: AiRunnerConfig) {
    this.historyFile = path.join(cfg.dataDir, 'ai-history.json');
    this.status = {
      enabled: cfg.enabled,
      llmConfigured: llmConfigured(),
      searchProvider: cfg.searchProvider,
      lastRunAt: 0,
      lastResult: '',
      totalDecisions: 0,
      totalApplied: 0,
      totalRejected: 0,
    };
  }

  start() {
    if (!this.cfg.enabled || !llmConfigured()) return;
    const run = () => this.runOnce().catch(() => { /* 静默 */ });
    run();
    const ms = Math.max(60_000, this.cfg.intervalMinutes * 60_000);
    this.timer = setInterval(run, ms);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 单轮决策：刷新数据层 → 对每个 running 机器人跑一次决策 → 应用合法建议 */
  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const robots = this.pickRobots();
      if (robots.length === 0) return;
      const symbols = [...new Set(robots.map((r) => r.symbol))];
      await Promise.allSettled([this.cfg.klines.refresh(symbols), this.cfg.news.refresh()]);
      for (const robot of robots) {
        const klines = this.cfg.klines.snapshot(robot.symbol);
        const news = this.cfg.news.snapshot();
        const raw = await this.askLlm(robot, klines, news);
        this.status.totalDecisions += 1;
        const applied = this.apply(robot, raw);
        const reason = raw && typeof raw === 'object' && 'reason' in raw ? String((raw as { reason?: unknown }).reason ?? '') : '';
        this.record(robot, raw, reason, applied);
        this.status.lastRunAt = Date.now();
        this.status.lastResult = applied ? `applied ${robot.symbol}` : `rejected ${robot.symbol}`;
      }
    } finally {
      this.running = false;
    }
  }

  private pickRobots(): Robot[] {
    const wanted = this.cfg.symbols;
    return this.cfg.engine.robots.filter(
      (r) => r.status === 'running'
        && (!wanted || wanted.length === 0 || wanted.includes(r.symbol))
        && !this.cfg.engine.emergencyStopped,
    );
  }

  private accountSummary(): string {
    const s = this.cfg.engine.summary();
    return `equity=${s.equity.toFixed(2)} USDT | 已实现盈亏=${s.realizedPnl.toFixed(2)} | 日内=${s.dailyPnl.toFixed(2)} | 回撤=${s.drawdownPercent.toFixed(2)}% | 敞口=${s.grossPosition.toFixed(2)} | 挂单=${s.reservedNotional.toFixed(2)}`;
  }

  private buildSystem(): string {
    return [
      '你是一个加密货币 Maker 网格交易机器人的"策略指挥官"。',
      '交易逻辑：机器人以最新价为网格中心双向挂 Post-Only 限价单（吃 Maker 返佣+价差）。你有权在安全范围内调整网格参数以适配市场状态，必须保守。',
      '市场状态判断：趋势强 → 放宽 halfRange、减少 gridCount；震荡 → 收窄 halfRange、加密 gridCount；波动率剧增 → 提高 shockPercent 熔断阈值、可减少开仓；库存偏斜严重 → 提高 inventorySkew 加速库存回归；亏损扩大 → 收紧 stopLossPercent。',
      '你只能输出 JSON：{"symbol":"...","adjustments":{...},"reason":"中文说明"}。只允许调整这些字段（出现其它字段违规）：' + AI_ALLOWED_FIELDS.join(', ') + '。',
      '约束：gridCount 必须为偶数；orderTtlSeconds 必须 ≥ repriceSeconds；每次单字段调整幅度不得超过现有值的 ±50%；如果你认为当前参数合适，adjustments 可为空对象，但 reason 仍要说明。',
      '禁止臆造数据；只依据提供的信息做判断；只输出 JSON，不要解释性文字。',
    ].join('\n');
  }

  private buildUser(robot: Robot, klines: KlineSummary[], news: NewsItem[]): string {
    const klineLines = klines.length
      ? klines.map((k) => `[${k.interval}] 收盘 ${k.lastPrice} 本周期 ${k.changePct.toFixed(3)}% 上周期 ${k.prevChangePct.toFixed(3)}% 24h高${k.high24} 低${k.low24} 振幅${k.amplitudePct.toFixed(2)}% 均量${Math.round(k.avgVolume)} 趋势${k.trend === 1 ? '↑' : k.trend === -1 ? '↓' : '→'}`).join('\n')
      : '（暂无K线）';
    const newsLines = news.length
      ? news.map((n) => `- ${n.title}`).join('\n')
      : '（暂无公告）';
    const paramLines = AI_ALLOWED_FIELDS.map((f) => `  ${f}: ${String(robot[f])}`).join('\n');
    return [
      `交易对：${robot.symbol}`,
      `机器人：${robot.name} | 状态 ${robot.status} | 持仓 ${robot.positionQty} | 已实现盈亏 ${robot.realizedPnl} | 累计费用 ${robot.fees}`,
      `账户概况：${this.accountSummary()}`,
      `当前可调参数：\n${paramLines}`,
      `【K线摘要】\n${klineLines}`,
      `【币安官方公告】\n${newsLines}`,
      '注意：币安广场社区动态暂不可直接抓取，如有需要请基于你自身的知识判断；切勿编造具体新闻。',
      '请输出你的 JSON 调参建议。',
    ].join('\n');
  }

  private async askLlm(robot: Robot, klines: KlineSummary[], news: NewsItem[]): Promise<unknown> {
    const content = await this.cfg.llm.chat({
      messages: [
        { role: 'system', content: this.buildSystem() },
        { role: 'user', content: this.buildUser(robot, klines, news) },
      ],
    });
    return parseLlmSuggestion(content);
  }

  /** 二次护栏后应用 */
  private apply(robot: Robot, raw: unknown): boolean {
    if (raw === null || raw === undefined) {
      this.cfg.engine.log('warning', 'ai', `AI 建议解析失败（${robot.symbol}）`, robot);
      this.status.totalRejected += 1;
      return false;
    }
    const guard = guardAiAdjustment(robot, raw);
    if (!guard.ok || !guard.validated) {
      this.cfg.engine.log('warning', 'ai', `AI 建议被护栏拒绝（${robot.symbol}）：${guard.rejectReason}`, robot);
      this.status.totalRejected += 1;
      return false;
    }
    try {
      this.cfg.engine.applyLiveParams(robot.id, guard.validated.adjustments);
      this.status.totalApplied += 1;
      return true;
    } catch (error) {
      this.cfg.engine.log('warning', 'ai', `AI 参数应用失败（${robot.symbol}）：${error instanceof Error ? error.message : String(error)}`, robot);
      this.status.totalRejected += 1;
      return false;
    }
  }

  /** 审计落库：ai-history.json（append 一行一条） */
  private record(robot: Robot, raw: unknown, reason: string, applied: boolean) {
    const entry = {
      at: Date.now(),
      symbol: robot.symbol,
      robotName: robot.name,
      suggestion: raw,
      applied,
      statusBefore: robot.status,
      orderSize: robot.orderSize,
      halfRange: robot.halfRange,
      gridCount: robot.gridCount,
      reason,
    };
    try {
      mkdirSync(path.dirname(this.historyFile), { recursive: true });
      writeFileSync(this.historyFile, JSON.stringify(entry) + '\n', { flag: 'a' });
    } catch {
      // 审计落库失败不影响交易
    }
  }

  /** 最近审计条目（供 /api/ai/status） */
  recentHistory(limit = 20): unknown[] {
    try {
      const text = readFileSync(this.historyFile, 'utf8');
      return text.split('\n').filter(Boolean).slice(-limit)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch {
      return [];
    }
  }
}

export { AI_ALLOWED_FIELDS };