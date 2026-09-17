// 联网搜索客户端（量化信息层 · 信息源②）
// 支持两种常见"给 LLM 用的搜索 API"：Tavily 与博查(Bocha)，也可在测试中注入 mock。
// 未配置任何搜索 Key 时返回空数组（降级：AI 只用知识库 + 币安公告）。

import { z } from 'zod';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchClient {
  search(query: string, opts?: { max?: number }): Promise<SearchResult[]>;
}

export class SearchNotConfiguredError extends Error {
  constructor() {
    super('SEARCH: 未配置搜索 API Key');
    this.name = 'SearchNotConfiguredError';
  }
}

const tavilySchema = z.object({
  results: z.array(z.object({
    title: z.string().default(''),
    url: z.string().default(''),
    content: z.string().default(''),
  })).default([]),
}).catch({ results: [] });

/** Tavily: POST https://api.tavily.com/search，Authorization: Bearer key */
export function makeTavilySearchClient(opts: { apiKey?: string; fetchFn?: typeof fetch }): SearchClient {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    async search(query, searchOpts = {}) {
      if (!opts.apiKey) return [];
      const response = await fetchFn('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: opts.apiKey, query, max_results: searchOpts.max ?? 5, search_depth: 'basic' }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
      const parsed = tavilySchema.parse(await response.json());
      return parsed.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
    },
  };
}

const bochaSchema = z.object({
  data: z.object({
    web_results: z.array(z.object({
      title: z.string().default(''),
      url: z.string().default(''),
      summary: z.string().default(''),
      site_name: z.string().default(''),
    })).default([]),
  }).catch({ web_results: [] }),
}).catch({ data: { web_results: [] } });

/** 博查: POST https://api.bochaai.com/v1/web-search，Authorization: Bearer key */
export function makeBochaSearchClient(opts: { apiKey?: string; fetchFn?: typeof fetch }): SearchClient {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    async search(query, searchOpts = {}) {
      if (!opts.apiKey) return [];
      const response = await fetchFn('https://api.bochaai.com/v1/web-search', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({ question: query, stream: false, freshness: 'oneMonth', count: searchOpts.max ?? 5 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Bocha HTTP ${response.status}`);
      const parsed = bochaSchema.parse(await response.json());
      return parsed.data.web_results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: `${r.site_name ? `[${r.site_name}] ` : ''}${r.summary}`,
      }));
    },
  };
}

export type SearchProvider = 'tavily' | 'bocha' | 'none';

export function makeSearchClient(env: NodeJS.ProcessEnv = process.env, opts: { fetchFn?: typeof fetch } = {}): SearchClient {
  const provider: SearchProvider = (env.SEARCH_PROVIDER || 'none') as SearchProvider;
  if (provider === 'tavily') return makeTavilySearchClient({ apiKey: env.TAVILY_API_KEY, fetchFn: opts.fetchFn });
  if (provider === 'bocha') return makeBochaSearchClient({ apiKey: env.BOCHA_API_KEY, fetchFn: opts.fetchFn });
  return { async search() { return []; } };
}