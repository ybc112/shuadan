// LLM 客户端（OpenAI 兼容 · DeepSeek 默认通道）
// 设计约束：
//   - 无第三方 SDK，纯 fetch；baseURL/apiKey/model 全部可配
//   - 超时 + 固定重试；失败抛 LLMError，由 commander 捕获降级
//   - 支持注入 fetchFn，便于测试不触发真实网络

import { z } from 'zod';

export interface LlmConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_LLM_MODEL = 'deepseek-chat';

export class LlmError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LlmRequest {
  messages: ChatMessage[];
  temperature?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const chatCompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
});

function readConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return {
    baseURL: env.LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL,
    apiKey: env.LLM_API_KEY?.trim(),
    model: env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL,
  };
}

export function llmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = readConfig(env);
  return Boolean(cfg.apiKey && cfg.baseURL && cfg.model);
}

export class LlmClient {
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly fetchFn: typeof fetch;

  constructor(config: LlmConfig = {}, opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.baseURL = config.baseURL || DEFAULT_LLM_BASE_URL;
    this.model = config.model || DEFAULT_LLM_MODEL;
    this.apiKey = config.apiKey || '';
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    return new LlmClient(readConfig(env), opts);
  }

  async chat(req: LlmRequest): Promise<string> {
    if (!this.apiKey) throw new LlmError('LLM_API_KEY 未配置', 'NOT_CONFIGURED');
    const url = `${this.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const payload = {
      model: this.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.3,
      // 仅提取 JSON：约束输出格式
      response_format: { type: 'json_object' } as const,
    };
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new LlmError(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`, `HTTP_${response.status}`);
        }
        const data: unknown = await response.json();
        const parsed = chatCompletionSchema.safeParse(data);
        if (!parsed.success) throw new LlmError('LLM 响应结构异常', 'BAD_SHAPE');
        return parsed.data.choices[0].message.content;
      } catch (error) {
        lastError = error;
        if (error instanceof LlmError && String(error.code).startsWith('HTTP_4')) throw error; // 4xx 不重试
      }
    }
    throw lastError instanceof Error ? lastError : new LlmError(String(lastError), 'NETWORK');
  }
}

export const llmMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});