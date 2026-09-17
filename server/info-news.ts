// 币安官方公告抓取（量化信息层 · 信息源①）
// 端点：bapi/composite/v1/public/cms/article/catalog/list/query（公开，无需鉴权）
// 设计约束：
//   - 只读；抓取失败返回 [], 绝不抛错
//   - 输出压缩为 {id,title,date?} 列表，正文细节交给 AI 判断是否要搜
//   - 币安广场(Square)公开接口在当前网络被反爬阻断，社区动态信息由 commander 侧的
//     web-search 降级补齐（见 commander.ts 的 prompt 备注），本模块不再尝试强抓

import { z } from 'zod';

export interface NewsItem {
  id: number;
  title: string;
  /** 可选发布说明；币安列表接口通常不带，保持空串 */
  summary: string;
}

const articleSchema = z.object({
  id: z.number({ coerce: true }).int(),
  title: z.string(),
  body: z.any().optional(),
  publishDate: z.any().optional(),
});

const catalogSchema = z.object({
  code: z.string(),
  data: z.object({
    articles: z.array(articleSchema).default([]),
  }).default({ articles: [] }),
});

export interface NewsFetcher {
  fetchAnnouncements(catalogId?: number, limit?: number): Promise<unknown>;
}

export function makeBinanceNewsFetcher(opts: { fetchFn?: typeof fetch } = {}): NewsFetcher {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    async fetchAnnouncements(catalogId = 48, limit = 5) {
      const url = new URL('https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query');
      url.searchParams.set('catalogId', String(catalogId));
      url.searchParams.set('pageNo', '1');
      url.searchParams.set('pageSize', String(limit));
      const response = await fetchFn(url.toString(), { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`公告接口 HTTP ${response.status}`);
      return response.json();
    },
  };
}

/** 把币安公告列表响应解析为压缩后的 NewsItem[]。失败返回 []（静默降级）。 */
export function parseAnnouncements(payload: unknown): NewsItem[] {
  const parsed = catalogSchema.safeParse(payload);
  if (!parsed.success) return [];
  return parsed.data.data.articles.map((a) => ({
    id: a.id,
    title: String(a.title ?? '').trim(),
    summary: '',
  })).filter((a) => a.title.length > 0);
}

/** 定时轮询公告，保留最近 N 条内存缓存。 */
export class NewsCollector {
  private items: NewsItem[] = [];
  private lastOkAt = 0;

  constructor(
    private fetcher: NewsFetcher,
    private opts: { catalogId?: number; limit?: number } = {},
  ) { }

  snapshot(): NewsItem[] {
    return this.items;
  }

  get lastUpdatedAt() {
    return this.lastOkAt;
  }

  async refresh(now = Date.now()): Promise<void> {
    try {
      const payload = await this.fetcher.fetchAnnouncements(this.opts.catalogId ?? 48, this.opts.limit ?? 8);
      const items = parseAnnouncements(payload);
      if (items.length === 0) return;
      this.items = items;
      this.lastOkAt = now;
    } catch {
      // 公告失败静默降级，保留旧缓存
    }
  }
}

export const newsItemSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  summary: z.string(),
});