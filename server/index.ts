import express, { type ErrorRequestHandler } from 'express';
import compression from 'compression';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { z, ZodError } from 'zod';
import { defaultConfig } from '../shared/config';
import { MakerEngine } from './engine';
import { BinancePublicFeed, SimulatedFeed } from './markets';
import { StateStore } from './storage';
import { BinanceReadOnlyClient, readOnlyConfigFromEnv, symbolSchema } from './binance-readonly';
import { BinanceTradingClient, tradingConfigFromEnv, type TradingConfig } from './binance-trading';
import { ConnectionInspector } from './connection-inspector';
import { installProxyFetch } from './proxy-fetch';
import { TradeLog } from './trade-log';
import { KlineCollector, makeBinanceKlinesFetcher } from './klines';
import { NewsCollector, makeBinanceNewsFetcher } from './info-news';
import { LlmClient } from './llm-client';
import { makeSearchClient } from './web-search';
import { AiRunner } from './ai-runner';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localEnvironment = path.join(root, '.env.local');
if (existsSync(localEnvironment)) loadEnvFile(localEnvironment);
if (process.env.HTTPS_PROXY) installProxyFetch(process.env.HTTPS_PROXY);
const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.PORT ?? 4318);
const production = process.argv.includes('--production');
if (production && !existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('请先执行 npm run build');
const store = new StateStore(process.env.MAKER_DATA_DIR ?? path.join(root, 'data'));
// 成交流水的独立持久化：state.json 里的 fills 有 2000 条上限且随账户状态全量重写，
// 这里用 SQLite 单独追加保存，可长期留存并支持运行时并发查询。
const tradeLog = new TradeLog(process.env.MAKER_TRADES_DB ?? path.join(process.env.MAKER_DATA_DIR ?? path.join(root, 'data'), 'trades.db'));
let engine = new MakerEngine(store.read());
engine.attachTradeLog(tradeLog);
if (store.recovered) engine.log('critical', 'system', '主数据文件验证失败，已从通过验证的备份恢复；所有策略暂停');
let simulation = new SimulatedFeed();
const binance = new BinancePublicFeed();
const inspector = new ConnectionInspector(new BinanceReadOnlyClient(readOnlyConfigFromEnv(process.env)));
const liveCredentialsFile = path.join(process.env.MAKER_DATA_DIR ?? path.join(root, 'data'), 'live-credentials.json');
const liveCredentialsSchema = z.object({
  environment: z.enum(['demo', 'production']), apiKey: z.string(), apiSecret: z.string(), savedAt: z.number(),
});
let liveCredentialsSource: 'env' | 'file' | 'none' = 'none';
function readLiveCredentials(): z.infer<typeof liveCredentialsSchema> | null {
  try { return liveCredentialsSchema.parse(JSON.parse(readFileSync(liveCredentialsFile, 'utf8'))); }
  catch { return null; }
}
function writeLiveCredentials(input: { environment: 'demo' | 'production'; apiKey: string; apiSecret: string }) {
  mkdirSync(path.dirname(liveCredentialsFile), { recursive: true });
  writeFileSync(liveCredentialsFile, JSON.stringify({ ...input, savedAt: Date.now() }), { mode: 0o600 });
}
function liveConfigFromAnySource(): { config: TradingConfig; source: 'env' | 'file' | 'none' } {
  const fromEnv = tradingConfigFromEnv(process.env);
  if (fromEnv.apiKey && fromEnv.apiSecret) return { config: fromEnv, source: 'env' };
  const fromFile = readLiveCredentials();
  if (fromFile?.apiKey && fromFile.apiSecret) return { config: fromFile, source: 'file' };
  return { config: fromEnv, source: 'none' };
}
let tradingClient: BinanceTradingClient;
{
  const loaded = liveConfigFromAnySource();
  liveCredentialsSource = loaded.source;
  tradingClient = new BinanceTradingClient(loaded.config);
}
engine.attachLiveBroker(tradingClient);

// ===== AI 策略指挥官（量化决策层）=====
// 数据层：币安 K线（fapi）+ 官方公告；币安广场公开接口被反爬阻断 → 由联网搜索(AI)降级补齐。
// 决策层：DeepSeek(OpenAI 兼容) + 可选搜索，全链路故障静默，不影响引擎主循环。
const aiDataDir = process.env.MAKER_DATA_DIR ?? path.join(root, 'data');
const aiKlines = new KlineCollector(makeBinanceKlinesFetcher({ endpoint: 'fapi' }));
const aiNews = new NewsCollector(makeBinanceNewsFetcher());
const aiSearch = makeSearchClient(process.env);
const aiLlm = LlmClient.fromEnv(process.env);
const aiRunner = new AiRunner({
  engine,
  klines: aiKlines,
  news: aiNews,
  llm: aiLlm,
  search: aiSearch,
  dataDir: aiDataDir,
  intervalMinutes: z.coerce.number().min(1).max(1440).catch(45).parse(process.env.LLM_INTERVAL_MIN ?? '45'),
  enabled: String(process.env.AI_ADMIN_ENABLED ?? '').toLowerCase() === 'true',
  searchProvider: String(process.env.SEARCH_PROVIDER || 'none'),
  symbols: String(process.env.AI_SYMBOLS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
});
const sessionToken = randomBytes(32).toString('hex');
let shuttingDown = false;
let persistenceFailed = false;
let lastSaved = 0;
let lastFeedError = '';
let lastEquityLog = 0;

const app = express();
app.disable('x-powered-by');
// gzip：/api/state 约 270KB、前端 JS 380KB，而这些内容（重复字段名的 JSON）压缩率极高——
// 实测整体可压到 13%。公网链路只有约 40KB/s 时，不压缩会直接导致页面加载不出来。
app.use(compression());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `154.89.195.153:${port}`, `:${port}`];
  if (!allowed.includes(req.headers.host ?? '')) { res.status(403).json({ error: '仅允许本机工作台访问' }); return; }
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if ((origin && !allowed.some(host => origin === `http://${host}`)) || req.headers['x-console-token'] !== sessionToken) {
        res.status(403).json({ error: '会话校验失败，请刷新本机页面' }); return;
      }
      if (persistenceFailed && req.path !== '/api/emergency-stop') {
        res.status(503).json({ error: '数据保存失败，系统已停止。请检查磁盘后重启服务' }); return;
      }
    }
  }
  next();
});
app.use(express.json({ limit: '64kb' }));

function save() {
  try { store.save(engine.persist()); lastSaved = Date.now(); }
  catch (error) {
    if (!persistenceFailed) engine.stopAll('数据保存失败，系统停止报价');
    persistenceFailed = true;
    throw error;
  }
}

/** 权益快照。纯观测用途，任何失败都不能影响交易主流程。 */
function recordEquitySnapshot(now: number) {
  try {
    const account = engine.liveAccount;
    if (engine.execution !== 'live' || !account) return;
    const robot = engine.robots[0];
    const market = robot ? engine.markets.find(m => m.symbol === robot.symbol) : undefined;
    tradeLog.recordEquity({
      ts: now,
      wallet: account.totalWalletBalance, available: account.availableBalance,
      unrealized: account.totalUnrealizedProfit, marginUsed: account.totalPositionInitialMargin,
      positionQty: robot?.positionQty ?? '0', markPrice: market?.markPrice ?? '0',
      execution: engine.execution,
    });
  } catch { /* 快照失败忽略 */ }
}

app.get('/api/health', (_req, res) => res.json({ ok: !persistenceFailed, execution: engine.execution, version: '1.1.0', capabilities: { binanceReadOnly: true, liveTrading: tradingClient.configured, environment: tradingClient.environment, configurationIssue: tradingClient.configurationIssue } }));
app.get('/api/state', (_req, res) => res.json({ ...engine.snapshot(), sessionToken }));
app.get('/api/binance/status', (_req, res) => res.json(inspector.status()));
app.get('/api/ai/status', (_req, res) => res.json({ ...aiRunner.status, recent: aiRunner.recentHistory(20) }));
app.post('/api/binance/check', (req, res) => {
  const input = z.object({ symbol: symbolSchema.default('BTCUSDT'), includeAccount: z.boolean().default(false) }).strict().parse(req.body);
  res.status(202).json(inspector.start(input.symbol, input.includeAccount));
});
app.post('/api/preview', (req, res) => res.json(engine.preview(req.body)));
app.post('/api/robots', (req, res) => { const robot = engine.addRobot(req.body); save(); res.status(201).json({ robot }); });
app.put('/api/robots/:id', (req, res) => { const robot = engine.editRobot(req.params.id, req.body); save(); res.json({ robot }); });
app.delete('/api/robots/:id', (req, res) => { engine.deleteRobot(req.params.id); save(); res.json({ ok: true }); });
app.post('/api/robots/:id/action', (req, res) => {
  const { action } = z.object({ action: z.enum(['start', 'pause', 'reduce']) }).strict().parse(req.body);
  if (action === 'start') engine.startRobot(req.params.id);
  if (action === 'pause') engine.pauseRobot(req.params.id);
  if (action === 'reduce') engine.reduceRobot(req.params.id);
  save(); res.json({ ok: true });
});
app.post('/api/batch-create', (req, res) => {
  const { quoteAsset } = z.object({ quoteAsset: z.enum(['USDC', 'USDT']) }).strict().parse(req.body);
  if (engine.feed.status !== 'connected') throw new Error('没有有效行情，暂不能生成榜单策略');
  const top = engine.markets.filter(m => m.quoteAsset === quoteAsset && Date.now() - m.updatedAt < engine.settings.staleAfterSeconds * 1000)
    .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 10);
  if (!top.length) throw new Error('没有可用的成交额榜单');
  const created: string[] = [], skipped: string[] = [], failed: { symbol: string; error: string }[] = [];
  for (const market of top) {
    if (engine.robots.some(r => r.symbol === market.symbol)) { skipped.push(market.symbol); continue; }
    try { engine.addRobot(defaultConfig(market)); created.push(market.symbol); }
    catch (error) { failed.push({ symbol: market.symbol, error: error instanceof Error ? error.message : '创建失败' }); }
  }
  save(); res.json({ created, skipped, failed });
});
app.post('/api/start-all', (_req, res) => {
  const started: string[] = [], failed: { symbol: string; error: string }[] = [];
  for (const robot of engine.robots.filter(r => r.status === 'paused')) {
    try { engine.startRobot(robot.id); started.push(robot.symbol); }
    catch (error) { failed.push({ symbol: robot.symbol, error: error instanceof Error ? error.message : '启动失败' }); }
  }
  save(); res.json({ started, failed });
});
app.post('/api/pause-all', (_req, res) => { engine.robots.forEach(r => engine.pauseRobot(r.id)); save(); res.json({ ok: true }); });
app.post('/api/emergency-stop', (_req, res) => { engine.stopAll(); save(); res.json({ ok: true }); });
// rebaseline=true：操作员点击「解除停止」是显式的人工复核行为。若不重置基准，回撤锁会永久卡住
// ——实测 2026-09-15 平掉裸头寸后权益 49.38、峰值 52.21，回撤 5.4% 一直 > 5%，机器人再也启不起来。
// 引擎默认仍是 false（保底不放行），只有这个显式接口才重置。
app.post('/api/clear-stop', (_req, res) => { engine.clearStop(Date.now(), true); save(); res.json({ ok: true }); });
app.put('/api/risk', (req, res) => { engine.updateRisk(req.body); save(); res.json({ ok: true }); });
app.get('/api/live/config', (_req, res) => {
  const saved = readLiveCredentials();
  res.json({
    configured: tradingClient.configured, configurationIssue: tradingClient.configurationIssue,
    environment: tradingClient.environment, source: liveCredentialsSource,
    keyTail: tradingClient.apiKeyTail(), savedAt: saved?.savedAt ?? null,
  });
});
app.post('/api/live/config', (req, res) => {
  if (engine.execution === 'live') { res.status(400).json({ error: '实盘运行中不能修改凭据；请先切回纸面模式' }); return; }
  const input = z.object({ environment: z.enum(['demo', 'production']), apiKey: z.string().trim(), apiSecret: z.string().trim() }).strict().parse(req.body);
  const saved = readLiveCredentials();
  const effective = { environment: input.environment, apiKey: input.apiKey || saved?.apiKey || '', apiSecret: input.apiSecret || saved?.apiSecret || '' };
  writeLiveCredentials(effective);
  liveCredentialsSource = 'file';
  tradingClient.configure(effective);
  engine.attachLiveBroker(tradingClient);

// ===== AI 策略指挥官（量化决策层）=====
// 数据层：币安 K线（fapi）+ 官方公告；币安广场公开接口被反爬阻断 → 由联网搜索(AI)降级补齐。
// 决策层：DeepSeek(OpenAI 兼容) + 可选搜索，全链路故障静默，不影响引擎主循环。
const aiDataDir = process.env.MAKER_DATA_DIR ?? path.join(root, 'data');
const aiKlines = new KlineCollector(makeBinanceKlinesFetcher({ endpoint: 'fapi' }));
const aiNews = new NewsCollector(makeBinanceNewsFetcher());
const aiSearch = makeSearchClient(process.env);
const aiLlm = LlmClient.fromEnv(process.env);
const aiRunner = new AiRunner({
  engine,
  klines: aiKlines,
  news: aiNews,
  llm: aiLlm,
  search: aiSearch,
  dataDir: aiDataDir,
  intervalMinutes: z.coerce.number().min(1).max(1440).catch(45).parse(process.env.LLM_INTERVAL_MIN ?? '45'),
  enabled: String(process.env.AI_ADMIN_ENABLED ?? '').toLowerCase() === 'true',
  searchProvider: String(process.env.SEARCH_PROVIDER || 'none'),
  symbols: String(process.env.AI_SYMBOLS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
});
  res.json({ ok: true, configured: tradingClient.configured, configurationIssue: tradingClient.configurationIssue,
    environment: tradingClient.environment, keyTail: tradingClient.apiKeyTail(), source: 'file' });
});
app.post('/api/live/config/clear', (_req, res) => {
  if (engine.execution === 'live') { res.status(400).json({ error: '实盘运行中不能清除凭据；请先切回纸面模式' }); return; }
  try { unlinkSync(liveCredentialsFile); } catch { /* 文件可能不存在 */ }
  const fromEnv = tradingConfigFromEnv(process.env);
  const fallback: TradingConfig = fromEnv.apiKey && fromEnv.apiSecret ? fromEnv : { environment: 'demo' };
  tradingClient.configure(fallback);
  engine.attachLiveBroker(tradingClient);

// ===== AI 策略指挥官（量化决策层）=====
// 数据层：币安 K线（fapi）+ 官方公告；币安广场公开接口被反爬阻断 → 由联网搜索(AI)降级补齐。
// 决策层：DeepSeek(OpenAI 兼容) + 可选搜索，全链路故障静默，不影响引擎主循环。
const aiDataDir = process.env.MAKER_DATA_DIR ?? path.join(root, 'data');
const aiKlines = new KlineCollector(makeBinanceKlinesFetcher({ endpoint: 'fapi' }));
const aiNews = new NewsCollector(makeBinanceNewsFetcher());
const aiSearch = makeSearchClient(process.env);
const aiLlm = LlmClient.fromEnv(process.env);
const aiRunner = new AiRunner({
  engine,
  klines: aiKlines,
  news: aiNews,
  llm: aiLlm,
  search: aiSearch,
  dataDir: aiDataDir,
  intervalMinutes: z.coerce.number().min(1).max(1440).catch(45).parse(process.env.LLM_INTERVAL_MIN ?? '45'),
  enabled: String(process.env.AI_ADMIN_ENABLED ?? '').toLowerCase() === 'true',
  searchProvider: String(process.env.SEARCH_PROVIDER || 'none'),
  symbols: String(process.env.AI_SYMBOLS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
});
  liveCredentialsSource = fromEnv.apiKey && fromEnv.apiSecret ? 'env' : 'none';
  res.json({ ok: true, configured: tradingClient.configured });
});
app.get('/api/execution/status', (_req, res) => res.json({
  execution: engine.execution, executionStatus: engine.executionStatus, executionMessage: engine.executionMessage,
  liveStatus: tradingClient.status(), liveAccount: engine.liveAccount,
  configured: tradingClient.configured, configurationIssue: tradingClient.configurationIssue,
}));
app.post('/api/execution/mode', async (req, res) => {
  const input = z.object({ mode: z.enum(['paper', 'live']), confirmation: z.string().optional() }).strict().parse(req.body);
  if (input.mode === 'live' && !tradingClient.configured) {
    res.status(400).json({ error: tradingClient.configurationIssue ?? '尚未配置实盘交易凭据' });
    return;
  }
  if (input.mode === 'live' && input.confirmation !== 'ENABLE LIVE TRADING') {
    res.status(400).json({ error: '切换到实盘需要显式确认' });
    return;
  }
  try { await engine.setExecution(input.mode); save(); res.json({ ok: true, execution: engine.execution, liveStatus: tradingClient.status(), executionMessage: engine.executionMessage }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '切换执行模式失败' }); }
});
app.post('/api/source', (req, res) => {
  const { source } = z.object({ source: z.enum(['simulation', 'binance']) }).strict().parse(req.body);
  const changed = source !== engine.source;
  engine.switchSource(source);
  if (changed) { binance.reset(); simulation = new SimulatedFeed(); }
  save(); res.json({ ok: true });
});
app.post('/api/scenario', (req, res) => {
  const { type } = z.object({ type: z.enum(['surge', 'crash', 'disconnect']) }).strict().parse(req.body);
  if (engine.source !== 'simulation') throw new Error('行情演练仅在本地模拟行情模式可用');
  simulation.scenario(type, Date.now());
  engine.log('warning', 'system', `开始模拟演练：${type === 'surge' ? '瞬时上涨 4%' : type === 'crash' ? '瞬时下跌 4%' : '行情断流 16 秒'}`);
  save(); res.json({ ok: true });
});
app.post('/api/reset', (req, res) => {
  z.object({ confirmation: z.literal('RESET') }).strict().parse(req.body);
  binance.reset(); simulation = new SimulatedFeed(); engine = new MakerEngine();
  engine.attachLiveBroker(tradingClient);

// ===== AI 策略指挥官（量化决策层）=====
// 数据层：币安 K线（fapi）+ 官方公告；币安广场公开接口被反爬阻断 → 由联网搜索(AI)降级补齐。
// 决策层：DeepSeek(OpenAI 兼容) + 可选搜索，全链路故障静默，不影响引擎主循环。
const aiDataDir = process.env.MAKER_DATA_DIR ?? path.join(root, 'data');
const aiKlines = new KlineCollector(makeBinanceKlinesFetcher({ endpoint: 'fapi' }));
const aiNews = new NewsCollector(makeBinanceNewsFetcher());
const aiSearch = makeSearchClient(process.env);
const aiLlm = LlmClient.fromEnv(process.env);
const aiRunner = new AiRunner({
  engine,
  klines: aiKlines,
  news: aiNews,
  llm: aiLlm,
  search: aiSearch,
  dataDir: aiDataDir,
  intervalMinutes: z.coerce.number().min(1).max(1440).catch(45).parse(process.env.LLM_INTERVAL_MIN ?? '45'),
  enabled: String(process.env.AI_ADMIN_ENABLED ?? '').toLowerCase() === 'true',
  searchProvider: String(process.env.SEARCH_PROVIDER || 'none'),
  symbols: String(process.env.AI_SYMBOLS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
});
  engine.attachTradeLog(tradeLog);
  engine.log('warning', 'system', '用户重置了工作台数据，恢复到空白初始状态');
  save(); res.json({ ok: true });
});
app.get('/api/export', (_req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="maker-simulation-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type('application/json').send(JSON.stringify(engine.persist(), null, 2));
});
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) { res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}：${i.message}`).join('；') }); return; }
  res.status(persistenceFailed ? 503 : 400).json({ error: error instanceof Error ? error.message : '请求失败' });
};
app.use(handleError);

let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
if (!production) {
  const { createServer } = await import('vite');
  vite = await createServer({ root, server: { middlewareMode: true, hmr: { host: '127.0.0.1', port: port + 1 } }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, 'dist')));
  app.use((_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
}

// 绑定所有网卡：这是运营者的明确选择，用于从公网直接访问工作台。
// 注意这意味着 154.89.195.153:4318 对全网开放，而 GET /api/state 无需认证即返回
// sessionToken，任何拿到它的人都能切换实盘、用真钱下单。Host 头白名单可伪造，不构成防护。
// 如需收紧：改回 '127.0.0.1' 配合 SSH 隧道，或在前面挂 nginx basic auth。
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`栖点 Maker 已启动：http://127.0.0.1:${port}`);
  console.log('已连接币安公开行情；未配置实盘凭据时仅展示真实数据，不做任何本地模拟。');
  console.log(`实盘交易：${tradingClient.configured ? '凭据已就绪（' + (liveCredentialsSource === 'env' ? '.env' : liveCredentialsSource === 'file' ? '页面保存' : '未知') + '），可在使用指南中切换到 ' + tradingClient.environment : '尚未配置实盘凭据，可在使用指南页面填写'}`);
});
aiRunner.start();

server.on('error', error => { console.error(error.message); store.release(); process.exit(1); });

const interval = setInterval(() => {
  if (shuttingDown || persistenceFailed) return;
  const now = Date.now();
  try {
    if (engine.source === 'simulation') {
      const markets = simulation.tick(engine.markets, now);
      if (markets) engine.acceptMarkets(markets, now);
    } else {
      void binance.poll(engine.markets, now, engine.robots.map(r => r.symbol)).then(markets => {
        if (shuttingDown || engine.source !== 'binance') return;
        if (markets) engine.acceptMarkets(markets);
        engine.feed = binance.status;
        if (binance.status.status === 'error' && lastFeedError !== binance.status.message) {
          lastFeedError = binance.status.message;
          engine.log('critical', 'system', binance.status.message);
        } else if (binance.status.status === 'connected') lastFeedError = '';
      });
    }
    engine.step(now);
    if (now - lastSaved >= 5000) save();
    // 每分钟落一条权益快照，用于事后画资金曲线、区分网格价差收入与方向性盈亏
    if (now - lastEquityLog >= 60000) { lastEquityLog = now; recordEquitySnapshot(now); }
  } catch (error) {
    engine.stopAll(error instanceof Error ? `内部错误：${error.message}` : '内部错误，停止报价');
    console.error(error instanceof Error ? error.message : error);
  }
}, 1000);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(interval);
  engine.robots.forEach(r => engine.pauseRobot(r.id));
  try { save(); } catch (error) { console.error(error); }
  tradeLog.close();
  await vite?.close();
  server.close(); store.release(); process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
