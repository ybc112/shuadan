import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowDownToLine, ArrowRight, ArrowUpRight, Bell, BookOpen, Bot, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, CircleHelp, CircleStop, Clock3, Download, FileClock, Globe2, Grid2X2, Layers3, LayoutDashboard, LoaderCircle, Menu, Pause, Play, Plus, Radio, RefreshCw, Search, Shield, ShieldCheck, SlidersHorizontal, Trash2, TrendingDown, TrendingUp, Wallet, Waves, Wifi, WifiOff, X, Zap } from 'lucide-react';
import type { AppState, AuditEvent, Market, QuoteAsset, RiskSettings, Robot, RobotConfig } from '../shared/types';
import { SIZING_LABELS } from '../shared/types';
import { defaultConfig, riskSchema } from '../shared/config';
import { api, setToken } from './api';
import { CoinIcon, Empty, External, Modal, PanelHeading, PriceChart, Sparkline, Status, compact, money, price, shortDate, signed, time } from './components';
import { Numeric, RobotForm } from './RobotForm';
import BinanceConnection from './BinanceConnection';

type Page = 'overview' | 'robots' | 'markets' | 'risk' | 'logs' | 'guide';
type Command = (path: string, method?: string, body?: unknown, success?: string) => Promise<any>;
const navigation: { id: Page; name: string; icon: typeof Bot }[] = [
  { id: 'overview', name: '工作台总览', icon: LayoutDashboard },
  { id: 'robots', name: '我的机器人', icon: Bot },
  { id: 'markets', name: '市场榜单', icon: TrendingUp },
  { id: 'risk', name: '风控中心', icon: ShieldCheck },
  { id: 'logs', name: '运行日志', icon: FileClock },
];
const pageNames: Record<Page, string> = { overview: '工作台总览', robots: '我的机器人', markets: '市场榜单', risk: '风控中心', logs: '运行日志', guide: '使用指南与设置' };

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [form, setForm] = useState<{ initial: RobotConfig; editing?: Robot } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; label: string; action: () => Promise<any>; reset?: boolean } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [chartSymbol, setChartSymbol] = useState('BTCUSDC');
  const [chartSeconds, setChartSeconds] = useState(180);
  const sequence = useRef(0);
  const active = useRef(true);

  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const next = await api<AppState>('/state');
      if (active.current && seq === sequence.current) { setToken(next.sessionToken ?? ''); setState(next); setConnectionError(''); }
    } catch (error) { if (active.current && seq === sequence.current) setConnectionError(error instanceof Error ? error.message : '服务连接中断'); }
  }, []);
  useEffect(() => { active.current = true; void refresh(); const timer = setInterval(() => void refresh(), 1500); return () => { active.current = false; clearInterval(timer); }; }, [refresh]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.error ? 10000 : 6000); return () => clearTimeout(timer); }, [toast]);

  const command: Command = async (path, method = 'POST', body, success) => {
    setBusy(true);
    try {
      const result = await api(path, method, body);
      await refresh();
      if (success) setToast({ text: success, error: false });
      return result;
    } catch (error) { setToast({ text: error instanceof Error ? error.message : '操作失败', error: true }); return null; }
    finally { setBusy(false); }
  };
  const go = (next: Page) => { setPage(next); setMobileNav(false); window.scrollTo({ top: 0 }); };
  const create = (market?: Market) => {
    const chosen = market ?? state?.markets.find(m => m.symbol === 'BTCUSDC') ?? state?.markets[0];
    if (chosen) setForm({ initial: defaultConfig(chosen) });
    else setToast({ text: '行情尚未就绪，暂不能创建策略', error: true });
  };
  const edit = (robot: Robot) => {
    if (!state?.markets.some(m => m.symbol === robot.symbol)) { setToast({ text: '该币行情未就绪，请连接行情后编辑', error: true }); return; }
    setDetailId(null); setForm({ initial: robot, editing: robot });
  };
  const robotAction = (robot: Robot, action: 'start' | 'pause' | 'reduce') => command(`/robots/${robot.id}/action`, 'POST', { action }, action === 'start' ? '机器人已启动' : action === 'pause' ? '已暂停并撤销挂单；持仓保留' : '已进入只减仓，等待 Maker 成交');
  const remove = (robot: Robot) => {
    setDetailId(null);
    setConfirmText('');
    setConfirmation({ title: `删除 ${robot.name}`, message: '将删除该机器人的配置并撤销其挂单。仍有持仓时，系统会阻止删除。已记录的成交不会被清除。', label: '删除机器人', action: async () => {
      const result = await command(`/robots/${robot.id}`, 'DELETE', undefined, '机器人已删除');
      if (result) setDetailId(null); return result;
    } });
  };
  const startAll = async () => {
    const result = await command('/start-all');
    if (result) setToast({ text: `已启动 ${result.started.length} 个机器人${result.failed.length ? `；${result.failed.map((f: { symbol: string; error: string }) => `${f.symbol}：${f.error}`).join('；')}` : ''}`, error: !!result.failed.length });
  };
  const batchCreate = async (quoteAsset: QuoteAsset) => {
    const result = await command('/batch-create', 'POST', { quoteAsset });
    if (result) { setToast({ text: `新增 ${result.created.length} 个机器人，跳过 ${result.skipped.length} 个已有合约${result.failed.length ? `；${result.failed.map((f: { symbol: string; error: string }) => `${f.symbol}：${f.error}`).join('；')}` : '。新策略保持暂停。'}`, error: !!result.failed.length }); }
  };
  const reset = () => {
    setConfirmText('');
    setConfirmation({ title: '重置工作台数据', message: '此操作会清除当前策略、成交和日志，回到空白初始状态（无任何预置数据）。可先导出记录。输入 RESET 后重置。', label: '重置工作台数据', reset: true, action: async () => {
      const result = await command('/reset', 'POST', { confirmation: 'RESET' }, '工作台数据已重置');
      if (result) { setDetailId(null); setChartSymbol('BTCUSDC'); } return result;
    } });
  };

  if (!state) return <div className="loading-screen"><div className="brand-mark"><ArrowUpRight size={28} /></div><h1>栖点 <span>Maker</span></h1>{connectionError ? <><p>无法连接本地服务：{connectionError}</p><button className="button secondary" onClick={() => void refresh()}><RefreshCw size={15} />重新连接</button></> : <p><LoaderCircle className="spin" size={15} />正在载入合约工作台</p>}</div>;
  const market = state.markets.find(m => m.symbol === chartSymbol) ?? state.markets[0];
  const detail = state.robots.find(r => r.id === detailId);
  const fresh = !connectionError && state.feed.status === 'connected';
  const canCreate = state.markets.length > 0 && !busy;
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <button className="brand" onClick={() => go('overview')} aria-label="栖点 Maker 首页"><span className="brand-mark"><ArrowUpRight size={28} strokeWidth={2.7} /></span><span className="brand-name">栖点<span>MAKER CONSOLE</span></span></button>
      <div className="workspace-chip"><span className="workspace-letter">P</span><div>个人工作空间<small>币安真实行情</small></div><ChevronDown size={14} /></div>
      <div className="nav-label">交易管理</div>
      <nav>{navigation.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => go(item.id)}><item.icon size={19} strokeWidth={1.7} /><span>{item.name}</span>{item.id === 'robots' && <em>{state.robots.length}</em>}{item.id === 'risk' && state.robots.some(r => r.status === 'cooldown') && <i className="nav-alert" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="tiny-icon"><ShieldCheck size={17} /></span><strong>先验证，再决策</strong><p>在真实行情下检验你的策略与风险边界。</p><button onClick={() => go('guide')}>了解工作方式<ArrowUpRight size={14} /></button></div>
        <button className={`nav-item ${page === 'guide' ? 'active' : ''}`} onClick={() => go('guide')}><BookOpen size={19} strokeWidth={1.7} /><span>使用指南与设置</span></button>
        <div className="sidebar-connection"><i className={connectionError ? 'red' : ''} /><span>本地服务{connectionError ? '断开' : '已连接'}</span><small>v1.1</small></div>
      </div>
    </aside>
    {mobileNav && <div className="nav-backdrop" onClick={() => setMobileNav(false)} />}
    <main className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="展开导航" onClick={() => setMobileNav(!mobileNav)}><Menu size={20} /></button><span>工作空间</span><ChevronRight size={13} /><strong>{pageNames[page]}</strong></div><div className="topbar-right"><span className={`environment-pill ${state.execution === "live" ? "live" : state.executionStatus === "error" ? "error" : ""}`}><span />{state.execution === "live" ? "实盘交易" : "纸面运行"}</span><span className={`feed-label ${fresh ? '' : 'negative'}`}>{fresh ? <Radio size={14} /> : <WifiOff size={14} />}{'币安真实行情'}</span><span className="topbar-time">{time(state.now)}</span><button className="icon-button" aria-label="查看风控提醒" onClick={() => go('logs')}><Bell size={18} />{state.events.some(e => e.level === 'critical' && state.now - e.time < 60000) && <i className="notification-dot" />}</button></div></header>
      <div className="page-content">
        {connectionError && <div className="alert-banner danger" role="alert"><WifiOff size={18} /><div><strong>本地服务连接中断</strong><span>页面为最后一次快照，不能据此判断撤单是否完成。请恢复服务连接。</span></div><button className="button secondary small" onClick={() => void refresh()}>重试</button></div>}
        {state.emergencyStopped && <div className="alert-banner danger" role="alert"><CircleStop size={20} /><div><strong>全局停止已生效 · {state.stopReason}</strong><span>所有挂单已撤销，持仓仍保留。解除停止后，机器人保持暂停。</span></div><button className="button danger-ghost small" onClick={() => void command('/clear-stop', 'POST', undefined, '停止锁已解除，需手动启动机器人')} disabled={busy}>解除停止</button></div>}
        {!connectionError && state.feed.status !== 'connected' && <div className="alert-banner warning" role="status"><WifiOff size={18} /><div><strong>行情连接{state.feed.status === 'connecting' ? '中' : '异常'}</strong><span>{state.feed.message}</span></div><button className="text-button" onClick={() => go('guide')}>查看设置<ArrowRight size={14} /></button></div>}
        <div className="page-heading"><div><div className="eyebrow">{page === 'overview' ? 'YOUR STRATEGY, IN VIEW' : page === 'risk' ? 'RISK BEFORE RETURN' : 'PERCH · MAKER WORKSPACE'}</div><h1>{page === 'overview' ? '合约工作台' : pageNames[page]}{page === 'overview' && <span className="heading-tag">U 本位永续</span>}</h1><p>{page === 'overview' ? '有序挂单，从容应对每一次市场变化。' : page === 'robots' ? '每个币种独立配置，每一笔订单都有边界。' : page === 'markets' ? '按 24 小时报价币成交额筛选，独立创建策略。' : page === 'risk' ? '把仓位、资金与极端行情放在同一张风险地图里。' : page === 'logs' ? '查看每次报价、状态变更和风险触发的记录。' : '了解配置、挂单与风控如何配合工作。'}</p></div>
          <div className="heading-actions">{(page === 'overview' || page === 'robots') && <><button className="button secondary" onClick={() => state.summary.runningCount ? void command('/pause-all', 'POST', undefined, '全部机器人已暂停，挂单已撤销，持仓保留') : void startAll()} disabled={busy || !fresh || state.emergencyStopped}>{state.summary.runningCount ? <Pause size={15} /> : <Play size={15} />}{state.summary.runningCount ? '全部暂停' : '启动'}</button><button className="button primary" onClick={() => create()} disabled={!canCreate}><Plus size={17} />创建机器人</button></>}{page === 'logs' && <a className="button secondary" href="/api/export" download><Download size={16} />导出记录</a>}</div>
        </div>

        {page === 'overview' && <>
          <div className={`simulation-strip ${state.execution === "live" ? "live-strip" : ""}`}><span><span className="strip-dot" />{state.execution === "live" ? "LIVE TRADING" : "PAPER"}</span><p>{state.execution === "live" ? '实盘模式已启用：所有挂单、撤单和同步都发送到币安交易。' : '当前连接币安真实行情；未配置实盘凭据时仅为纸面成交。'}</p><button onClick={() => go('guide')}>环境设置<ArrowUpRight size={14} /></button></div>
          <SummaryCards state={state} />
          <div className="overview-grid"><section className="panel market-panel"><PanelHeading title="市场与挂单"><div className="chart-controls"><select aria-label="图表交易合约" value={market?.symbol ?? ''} onChange={e => setChartSymbol(e.target.value)}>{state.markets.slice().sort((a, b) => b.quoteVolume - a.quoteVolume).map(m => <option key={m.symbol} value={m.symbol}>{m.symbol}</option>)}</select><div className="mini-segment"><button className={chartSeconds === 60 ? 'selected' : ''} onClick={() => setChartSeconds(60)}>1 分</button><button className={chartSeconds === 180 ? 'selected' : ''} onClick={() => setChartSeconds(180)}>3 分</button></div></div></PanelHeading>
            {market ? <><div className="chart-market-info"><CoinIcon base={market.baseAsset} /><div><strong>{market.baseAsset}<span> / {market.quoteAsset}</span></strong><small>永续合约 · 标记价格</small></div><div className="market-price"><strong>{price(market.markPrice)}</strong><span className={market.changePercent >= 0 ? 'positive' : 'negative'}>{signed(market.changePercent)}% <small>24h</small></span></div></div><PriceChart market={market} orders={state.orders.filter(o => o.symbol === market.symbol)} seconds={chartSeconds} /><div className="chart-bottom"><span><i className="legend-line" />标记价格</span><span><i className="legend-dash green" />最近买单</span><span><i className="legend-dash red" />最近卖单</span><small>{'币安公开行情'} · {time(market.updatedAt)}</small></div></> : <Empty title="等待行情连接" detail="连接成功后展示价格与挂单位置" />}
          </section><RiskOverview state={state} onOpen={() => go('risk')} /></div>
          <RobotTable state={state} onDetail={r => setDetailId(r.id)} onEdit={edit} onAction={robotAction} onCreate={() => create()} busy={busy || !fresh} />
          <div className="activity-footer"><span><CheckCheck size={15} />{state.events[0]?.message ?? '工作台已就绪'}</span><button className="text-button" onClick={() => go('logs')}>查看日志<ArrowRight size={14} /></button></div>
        </>}
        {page === 'robots' && <><div className="robot-summary"><span><Bot size={18} /><b>{state.robots.length}</b> 个机器人</span><span><i className="dot green" /><b>{state.summary.runningCount}</b> 个运行中</span><span><i className="dot amber" /><b>{state.robots.filter(r => r.status === 'cooldown').length}</b> 个熔断</span><span><Layers3 size={16} /><b>{state.orders.length}</b> 笔挂单</span></div><RobotTable state={state} onDetail={r => setDetailId(r.id)} onEdit={edit} onAction={robotAction} onCreate={() => create()} busy={busy || !fresh} full /></>}
        {page === 'markets' && <MarketPage state={state} onCreate={create} onDetail={r => setDetailId(r.id)} onBatch={batchCreate} busy={busy || !fresh} />}
        {page === 'risk' && <RiskPage state={state} command={command} busy={busy} />}
        {page === 'logs' && <LogsPage events={state.events} />}
        {page === 'guide' && <><BinanceConnection /><Guide state={state} command={command} onReset={reset} busy={busy} /></>}
        <footer className="page-footer"><span>栖点 Maker <i />币安合约工作台</span><span>Post-only · 独立资金预算 · 可追溯风控</span><button onClick={() => go('guide')}><CircleHelp size={13} />使用帮助</button></footer>
      </div>
    </main>
    <button className={`emergency-button ${state.emergencyStopped ? 'stopped' : ''}`} onClick={() => void command('/emergency-stop', 'POST', undefined, '已紧急停止并撤销全部挂单；现有持仓保留')} disabled={state.emergencyStopped || !!connectionError}><CircleStop size={17} />{state.emergencyStopped ? '全局已停止' : '紧急停止'}</button>
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleAlert size={19} /> : <Check size={19} />}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
    {form && <RobotForm markets={state.markets} initial={form.initial} editing={form.editing} onClose={() => setForm(null)} onSaved={async message => { await refresh(); setToast({ text: message, error: false }); }} />}
    {detail && <RobotDetail robot={detail} state={state} onClose={() => setDetailId(null)} onEdit={() => edit(detail)} onDelete={() => remove(detail)} onAction={action => robotAction(detail, action)} busy={busy || !fresh} />}
    {confirmation && <Modal title={confirmation.title} onClose={() => setConfirmation(null)} eyebrow="CONFIRM ACTION"><div className="confirm-body"><CircleAlert size={34} /><p>{confirmation.message}</p>{confirmation.reset && <input aria-label="输入 RESET 确认重置" value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="RESET" autoComplete="off" />}</div><div className="modal-footer"><a href="/api/export" download className="text-link">导出当前记录<Download size={13} /></a><div><button className="button secondary" onClick={() => setConfirmation(null)}>取消</button><button className="button danger" disabled={busy || (confirmation.reset && confirmText !== 'RESET')} onClick={async () => { const result = await confirmation.action(); if (result) setConfirmation(null); }}>{confirmation.label}</button></div></div></Modal>}
  </div>;
}

function SummaryCards({ state }: { state: AppState }) {
  const s = state.summary;
  const utilization = Math.min(100, (s.grossPosition + s.reservedNotional) / state.settings.maxGrossNotional * 100);
  return <div className="summary-grid">
    <section className="stat-card"><div className="stat-label">账户权益<Wallet size={17} /></div><div className="stat-value">{money(s.equity)}<span>U</span></div><div className="stat-bottom"><span className="soft-dot" />币安 U 本位真实账户</div><div className="stat-footnote">启用实盘后展示</div></section>
    <section className="stat-card"><div className="stat-label">累计盈亏<TrendingUp size={17} /></div><div className={`stat-value ${s.realizedPnl + s.unrealizedPnl >= 0 ? 'positive' : 'negative'}`}>{signed(s.realizedPnl + s.unrealizedPnl)}<span>U</span></div><div className="stat-bottom">浮动盈亏 <b className={s.unrealizedPnl >= 0 ? 'positive' : 'negative'}>{signed(s.unrealizedPnl)} U</b></div><div className="stat-footnote">真实成交已实现 + 浮盈，已扣手续费 {money(s.fees, 4)} U</div></section>
    <section className="stat-card"><div className="stat-label">持仓与挂单敞口<Layers3 size={17} /></div><div className="stat-value">{money(s.grossPosition + s.reservedNotional)}<span>U</span></div><div className="stat-progress"><i style={{ width: `${utilization}%` }} /></div><div className="stat-bottom">总限额 {money(state.settings.maxGrossNotional, 0)} U <b>{money(utilization, 1)}%</b></div></section>
    <section className="stat-card"><div className="stat-label">当前 Maker 挂单<Grid2X2 size={17} /></div><div className="stat-value">{s.ordersCount}<span>笔</span><span className="stat-tag">GTX</span></div><div className="stat-bottom"><span className={`dot ${s.runningCount ? 'green' : 'muted'}`} />{s.runningCount} / {state.robots.length} 个机器人运行中</div><div className="stat-footnote">仅被动限价 · 无市价订单</div></section>
  </div>;
}

function RiskOverview({ state, onOpen }: { state: AppState; onOpen: () => void }) {
  const ratio = state.summary.equity > 0 ? state.summary.usedMargin / state.summary.equity * 100 : 0;
  const risk = state.emergencyStopped || state.robots.some(r => r.status === 'cooldown');
  const circle = 2 * Math.PI * 45;
  return <section className="panel risk-overview"><PanelHeading title="风控状态"><span className={`risk-state ${risk ? 'attention' : ''}`}><i />{risk ? '需要关注' : '规则已启用'}</span></PanelHeading><div className="risk-gauge"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="45" fill="none" stroke="#2a3235" strokeWidth="6" /><circle cx="60" cy="60" r="45" fill="none" stroke={risk ? '#e7b46f' : '#b9e78c'} strokeWidth="6" strokeDasharray={`${Math.max(3, Math.min(1, ratio / state.settings.maxMarginPercent) * circle)} ${circle}`} strokeLinecap="round" transform="rotate(-90 60 60)" /></svg><div><ShieldCheck size={21} /><strong>{money(ratio, 1)}<small>%</small></strong><span>保证金占用</span></div></div><div className="risk-limit-caption">控制在 <b>{state.settings.maxMarginPercent}%</b> 以内 · 按保证金币种校验</div><div className="risk-checks"><div><span><Check size={13} />仓位与挂单预算</span><b>已启用</b></div><div><span><Check size={13} />过期行情撤单</span><b>{state.settings.staleAfterSeconds} 秒</b></div><div><span><Check size={13} />撤改限频</span><b>{state.settings.maxActionsPerMinute} 次 / 分</b></div></div><button className="risk-open" onClick={onOpen}>查看风控规则<ArrowRight size={15} /></button></section>;
}

function RobotTable({ state, onDetail, onEdit, onAction, onCreate, busy, full = false }: {
  state: AppState; onDetail: (r: Robot) => void; onEdit: (r: Robot) => void; onAction: (r: Robot, action: 'start' | 'pause' | 'reduce') => void; onCreate: () => void; busy: boolean; full?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [quote, setQuote] = useState('all');
  const filtered = state.robots.filter(r => (status === 'all' || r.status === status) && (quote === 'all' || r.symbol.endsWith(quote)) && `${r.name} ${r.symbol}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="panel robot-panel"><PanelHeading title={full ? '策略列表' : '我的机器人'}><div className="table-tools"><div className="search-input"><Search size={14} /><input aria-label="搜索机器人" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称或币种" /></div><select aria-label="按状态筛选机器人" value={status} onChange={e => setStatus(e.target.value)}><option value="all">全部状态</option><option value="running">运行中</option><option value="paused">已暂停</option><option value="cooldown">风控熔断</option><option value="reduce_only">只减仓</option></select>{full && <select aria-label="按保证金币种筛选" value={quote} onChange={e => setQuote(e.target.value)}><option value="all">全部 U 本位</option><option>USDC</option><option>USDT</option></select>}</div></PanelHeading>
    <div className="table-scroll"><table className="robot-table"><thead><tr><th>机器人 / 合约</th><th>网格配置</th><th>每格下单量</th><th>状态</th><th>持仓 / 浮动盈亏</th><th>当前挂单</th><th className="align-right">操作</th></tr></thead><tbody>{filtered.map(robot => {
      const market = state.markets.find(m => m.symbol === robot.symbol), base = market?.baseAsset ?? robot.symbol.replace(/USDC$|USDT$/, '');
      const orders = state.orders.filter(o => o.robotId === robot.id);
      const unrealized = market ? (Number(market.markPrice) - Number(robot.entryPrice)) * Number(robot.positionQty) : null;
      const live = robot.status === 'running' || robot.status === 'reduce_only';
      return <tr key={robot.id}><td><button className="robot-identity" onClick={() => onDetail(robot)}><CoinIcon base={base} /><span><strong>{robot.name}</strong><small>{robot.symbol}<i />{robot.leverage}×</small></span></button></td><td><strong>{robot.gridCount} 格</strong><small>{robot.rangeMode === 'fixed' ? `± ${robot.halfRange} U` : `± ${robot.halfRange / 100}%`} · {robot.recenterMinutes} 分钟</small></td><td><strong>{money(robot.orderSize, robot.sizingMode === 'base' ? 6 : 2)} <span className="unit">{robot.sizingMode.endsWith('_pct') ? '%' : robot.sizingMode === 'quote' ? 'U' : robot.sizingMode === 'contracts' ? '张' : base}</span></strong><small>{SIZING_LABELS[robot.sizingMode]}</small></td><td><Status value={robot.status} /></td><td><strong>{Math.abs(Number(robot.positionQty)) < 1e-12 ? '—' : `${Number(robot.positionQty) > 0 ? '多' : '空'} ${money(Math.abs(Number(robot.positionQty)), 6)}`}</strong><small className={(unrealized ?? 0) >= 0 ? 'positive' : 'negative'}>{unrealized === null ? '行情缺失' : `${signed(unrealized)} U`}</small></td><td><strong>{orders.length}<span className="muted"> / {robot.gridCount}</span></strong><small className="order-count"><span className="positive">买 {orders.filter(o => o.side === 'BUY').length}</span><span className="negative">卖 {orders.filter(o => o.side === 'SELL').length}</span></small></td><td><div className="row-actions"><button className={`icon-button ${live ? '' : 'play-button'}`} aria-label={`${live ? '暂停' : '启动'} ${robot.name}`} title={live ? '暂停并撤单' : '启动'} disabled={busy || state.emergencyStopped} onClick={() => onAction(robot, live ? 'pause' : 'start')}>{live ? <Pause size={15} /> : <Play size={15} />}</button><button className="icon-button" aria-label={`编辑 ${robot.name}`} onClick={() => onEdit(robot)} title="修改参数"><SlidersHorizontal size={15} /></button><button className="icon-button" aria-label={`查看 ${robot.name} 详情`} onClick={() => onDetail(robot)}><ChevronRight size={17} /></button></div></td></tr>;
    })}</tbody></table></div>{filtered.length === 0 && <Empty title={state.robots.length ? '没有匹配的机器人' : '创建你的第一个机器人'} detail={state.robots.length ? '试试其他币种或状态筛选' : '设置每格金额和风险上限，开始挂单'}>{!state.robots.length && <button className="button primary" onClick={onCreate}><Plus size={15} />创建机器人</button>}</Empty>}
    <div className="table-footer"><span>共 {filtered.length} 个机器人<span className="divider-inline">|</span>点击名称查看挂单详情</span><span><Shield size={12} />只挂 Maker，独立管理</span></div>
  </section>;
}

function MarketPage({ state, onCreate, onDetail, onBatch, busy }: { state: AppState; onCreate: (m: Market) => void; onDetail: (r: Robot) => void; onBatch: (asset: QuoteAsset) => void; busy: boolean }) {
  const [asset, setAsset] = useState<QuoteAsset>('USDC');
  const markets = state.markets.filter(m => m.quoteAsset === asset).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 10);
  return <><div className="market-page-banner"><div><span className="eyebrow">TOP 10 · USDⓈ-M</span><h2>从流动性开始选择</h2><p>{'筛选交易中的 U 本位永续，按该保证金币种的 24 小时成交额排名。'}</p></div><div className="banner-visual" aria-hidden="true"><span /><span /><span /><span /><span /><TrendingUp size={44} /></div></div><section className="panel"><PanelHeading title="成交额前 10 合约" description={'币安公开数据 · 成交额每 60 秒更新'}><div className="heading-actions"><div className="segmented compact-segment">{(['USDC', 'USDT'] as const).map(a => <button key={a} className={asset === a ? 'selected' : ''} onClick={() => setAsset(a)}>{a}</button>)}</div><button className="button primary small" disabled={busy || !markets.length} onClick={() => onBatch(asset)}><Plus size={15} />按榜单批量创建</button></div></PanelHeading><div className="table-scroll"><table className="market-table"><thead><tr><th>#</th><th>交易合约</th><th>标记价格</th><th>24h 涨跌幅</th><th>24h 成交额</th><th>最近走势</th><th>数量 / 价格步长</th><th className="align-right">策略</th></tr></thead><tbody>{markets.map((m, i) => {
    const robot = state.robots.find(r => r.symbol === m.symbol);
    return <tr key={m.symbol}><td><span className={`rank ${i < 3 ? 'top' : ''}`}>{String(i + 1).padStart(2, '0')}</span></td><td><div className="coin-cell"><CoinIcon base={m.baseAsset} /><div><strong>{m.symbol}</strong><small>U 本位永续</small></div></div></td><td><strong>{price(m.markPrice)}</strong><small>{asset}</small></td><td className={m.changePercent >= 0 ? 'positive' : 'negative'}>{signed(m.changePercent)}%</td><td>{compact(m.quoteVolume)}<small>{asset}</small></td><td><Sparkline values={m.history.map(h => h.price)} positive={m.changePercent >= 0} /></td><td><span className="mono">{m.quantityStep} / {m.priceTick}</span></td><td className="align-right"><button className={`button ${robot ? 'secondary' : 'subtle'} small`} disabled={busy} onClick={() => robot ? onDetail(robot) : onCreate(m)}>{robot ? '查看机器人' : '创建策略'}{robot ? <ArrowUpRight size={13} /> : <Plus size={13} />}</button></td></tr>;
  })}</tbody></table></div>{!markets.length && <Empty title="尚未取得榜单" detail={state.feed.message} />}<div className="table-footer"><span>批量创建会跳过已有合约，新增机器人保持暂停。</span><span>每币参数可单独修改</span></div></section></>;
}

function RiskPage({ state, command, busy }: { state: AppState; command: Command; busy: boolean }) {
  const [settings, setSettings] = useState<RiskSettings>({ ...state.settings });
  const [error, setError] = useState('');
  const change = (key: keyof RiskSettings, value: number) => setSettings(s => ({ ...s, [key]: value }));
  const save = async () => {
    const validated = riskSchema.safeParse(settings);
    if (!validated.success) { setError(validated.error.issues.map(i => `${i.path[0]}：${i.message}`).join('；')); return; }
    setError(''); await command('/risk', 'PUT', settings, '风控参数已保存，已立即复核全部机器人');
  };
  return <><div className="risk-page-grid"><section className="panel risk-settings"><PanelHeading title="全局风险边界" description="机器人级限制与全局限制同时生效"><span className="tag"><ShieldCheck size={12} />始终启用</span></PanelHeading><div className="field-grid"><Numeric label="持仓 + 开仓挂单总限额" value={settings.maxGrossNotional} onChange={v => change('maxGrossNotional', v)} unit="U" min={100} hint="所有币种合计，不用多空抵消掩盖风险" /><Numeric label="每个保证金账户最大占用" value={settings.maxMarginPercent} onChange={v => change('maxMarginPercent', v)} unit="%" min={1} max={80} hint="USDC、USDT 分别计算，挂单预留也占用额度" /><Numeric label="账户日内亏损上限" value={settings.dailyLossLimit} onChange={v => change('dailyLossLimit', v)} unit="U" min={1} hint="含浮动盈亏，每日 UTC 00:00 更新基准" /><Numeric label="账户最高权益回撤上限" value={settings.maxDrawdownPercent} onChange={v => change('maxDrawdownPercent', v)} unit="%" min={0.1} max={30} hint="触发后锁定全局停止，禁止自动重启" /><Numeric label="行情过期阈值" value={settings.staleAfterSeconds} onChange={v => change('staleAfterSeconds', v)} unit="秒" min={3} max={30} step={1} hint="过期或断流时取消相关订单" /><Numeric label="普通撤改挂单频率上限" value={settings.maxActionsPerMinute} onChange={v => change('maxActionsPerMinute', v)} unit="次 / 分" min={20} max={600} step={1} hint="紧急撤单不等待普通操作额度" /></div>{error && <div className="form-error" role="alert">{error}</div>}<div className="settings-footer"><span>修改后立即执行风险检查</span><button className="button primary" onClick={() => void save()} disabled={busy}><Check size={15} />保存风控规则</button></div></section><section className="panel account-panel"><PanelHeading title="账户资金" /><div className="account-total"><span>当前总权益</span><strong>{money(state.summary.equity)}<small>U</small></strong></div>{state.summary.accounts.map(account => <div className="account-row" key={account.asset}><div><span className={`asset-icon ${account.asset === 'USDT' ? 'tether' : ''}`}>$</span><strong>{account.asset}</strong><b>{money(account.equity)}</b></div><div><span>已用 / 预留保证金</span><b>{money(account.usedMargin)}</b></div><div><span>可用余额</span><b className="positive">{money(account.available)}</b></div><div className="stat-progress"><i style={{ width: `${Math.min(100, Number(account.usedMargin) / Math.max(1, Number(account.equity)) * 100)}%` }} /></div></div>)}<div className="account-daily"><span>今日净盈亏<strong className={state.summary.dailyPnl >= 0 ? 'positive' : 'negative'}>{signed(state.summary.dailyPnl)} U</strong></span><span>当前回撤<strong>{money(state.summary.drawdownPercent)}%</strong></span></div><p className="small-muted">启用实盘后，此账户数据为币安真实余额；未启用时为 0，不做虚拟展示。</p></section></div>
    
<div className="risk-principles"><div><span>01</span><strong>异常即停</strong><p>行情失效、短时剧烈波动时撤单，保留持仓记录。</p></div><div><span>02</span><strong>限制单边累积</strong><p>同侧全部成交也要在限额内，持仓达到 80% 转只减仓。</p></div><div><span>03</span><strong>Maker 有成交边界</strong><p>限价单可能无法成交，系统不承诺避免强平或固定止损。</p></div></div>
  </>;
}

function LogsPage({ events }: { events: AuditEvent[] }) {
  const [level, setLevel] = useState('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(40);
  const filtered = events.filter(e => (level === 'all' || e.level === level) && `${e.message} ${e.symbol ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const levels = { info: '信息', warning: '注意', critical: '风险' };
  const category: Record<string, string> = { system: '系统', order: '订单', robot: '机器人', risk: '风控', live: '实盘账户' };
  return <section className="panel logs-panel"><PanelHeading title="事件记录" description="页面展示最近 200 条；导出包含最多 600 条事件和 2,000 笔成交"><div className="table-tools"><div className="search-input"><Search size={14} /><input aria-label="搜索运行日志" placeholder="搜索事件或币种" value={query} onChange={e => { setQuery(e.target.value); setLimit(40); }} /></div><select aria-label="筛选日志级别" value={level} onChange={e => { setLevel(e.target.value); setLimit(40); }}><option value="all">全部级别</option><option value="info">信息</option><option value="warning">注意</option><option value="critical">风险</option></select></div></PanelHeading><div className="log-list">{filtered.slice(0, limit).map(event => <div className={`log-entry ${event.level}`} key={event.id}><div className="log-icon">{event.level === 'critical' ? <Shield size={17} /> : event.category === 'order' ? <ArrowDownLeft size={17} /> : <Activity size={17} />}</div><div className="log-body"><div><span className={`log-level ${event.level}`}>{levels[event.level]}</span><span>{category[event.category]}</span>{event.symbol && <b>{event.symbol}</b>}</div><p>{event.message}</p></div><time>{shortDate(event.time)}</time></div>)}</div>{!filtered.length && <Empty title="没有匹配的事件" detail="调整筛选条件，或启动机器人产生运行记录" />}<div className="table-footer"><span>显示 {Math.min(limit, filtered.length)} / {filtered.length} 条</span>{limit < filtered.length && <button className="text-button" onClick={() => setLimit(n => n + 40)}>加载更多<ChevronDown size={14} /></button>}</div></section>;
}

function LiveTradingPanel({ state, command, busy }: { state: AppState; command: Command; busy: boolean }) {
  const [liveConfirm, setLiveConfirm] = useState("");
  const [credEnv, setCredEnv] = useState<"demo" | "production">(state.liveStatus?.environment ?? "demo");
  const [apiKeyText, setApiKeyText] = useState("");
  const [apiSecretText, setApiSecretText] = useState("");
  const [credInfo, setCredInfo] = useState<{ configured: boolean; configurationIssue: string | null; environment: string; source: string; keyTail: string | null; savedAt: number | null } | null>(null);
  const [savingCred, setSavingCred] = useState(false);
  const loadCred = useCallback(() => {
    void api<{ configured: boolean; configurationIssue: string | null; environment: string; source: string; keyTail: string | null; savedAt: number | null }>("/live/config")
      .then(c => { setCredInfo(c); setCredEnv((c.environment as "demo" | "production") ?? "demo"); setApiKeyText(""); setApiSecretText(""); })
      .catch(() => {});
  }, []);
  useEffect(() => { loadCred(); }, [loadCred]);
  const saveCred = async () => {
    setSavingCred(true);
    const result = await command("/live/config", "POST", { environment: credEnv, apiKey: apiKeyText, apiSecret: apiSecretText }, "实盘凭据已保存到本机");
    setSavingCred(false);
    if (result?.ok) loadCred();
  };
  const clearCred = async () => {
    setSavingCred(true);
    await command("/live/config/clear", "POST", {}, "已清除实盘凭据");
    setSavingCred(false);
    loadCred();
  };
  const isLive = state.execution === "live";
  const liveStatus = state.liveStatus;
  const walletUSDT = state.liveAccount?.assets.find((a: { asset: string }) => a.asset === "USDT");
  const walletUSDC = state.liveAccount?.assets.find((a: { asset: string }) => a.asset === "USDC");
  const switchMode = async (target: "paper" | "live") => {
    if (target === "live") {
      if (liveConfirm !== "ENABLE LIVE TRADING") return;
      await command("/execution/mode", "POST", { mode: "live", confirmation: liveConfirm }, "\u5df2\u5207\u6362\u5230\u5b9e\u76d8\u4ea4\u6613");
      setLiveConfirm("");
    } else {
      await command("/execution/mode", "POST", { mode: "paper" }, "\u5df2\u5207\u6362\u56de\u672c\u5730\u6a21\u62df\u4ea4\u6613");
    }
  };
  return <section className="panel">
    <PanelHeading title={isLive ? "\u5b9e\u76d8\u4ea4\u6613\u72b6\u6001" : "\u542f\u7528\u5b9e\u76d8\u4ea4\u6613"} description={isLive ? "\u6240\u6709\u6302\u5355\u3001\u64a4\u5355\u548c\u8d26\u6237\u540c\u6b65\u90fd\u53d1\u9001\u5230\u5e01\u5b89\u4ea4\u6613\uff0c\u4ec5\u4f7f\u7528\u0020\u0050\u006f\u0073\u0074\u002d\u006f\u006e\u006c\u0079\u0020\u0047\u0054\u0058\u0020\u9650\u4ef7\u5355\u3002" : "\u6ce8\u5165\u0020\u0048\u004d\u0041\u0043\u0020\u4ea4\u6613\u51ed\u636e\u540e\u53ef\u4ee5\u4ece\u6a21\u62df\u5207\u6362\u5230\u5b9e\u76d8\u3002\u672c\u5de5\u4f5c\u53f0\u4ecd\u4ec5\u53d1\u9001\u88ab\u52a8\u9650\u4ef7\u5355\uff0c\u4e0d\u4f1a\u53d1\u9001\u5e02\u4ef7\u5355\u3002"} />
    <div className="execution-card">
      <div className="exec-status">
        <span className={"dot " + state.executionStatus} />
        <strong>{isLive ? "\u5b9e\u76d8\u4ea4\u6613\u8fd0\u884c\u4e2d" : state.executionStatus === "switching" ? "\u6b63\u5728\u5207\u6362\u6267\u884c\u6a21\u5f0f" : state.executionStatus === "error" ? "\u5207\u6362\u6216\u540c\u6b65\u51fa\u9519" : "\u672c\u5730\u6a21\u62df\u4ea4\u6613"}</strong>
        {state.executionMessage && <span className="exec-hint">{state.executionMessage}</span>}
      </div>
      {liveStatus && <div className="exec-hint">
        \u73af\u5883：<strong>{liveStatus.environment === "production" ? "\u5e01\u5b89\u6b63\u5f0f\u73af\u5883" : "Binance Demo"}</strong>
        · \u65f6\u949f\u6821\u51c6 <strong>{liveStatus.lastSyncedAt ? "\u5df2\u6821\u51c6" : "\u5c1a\u672a\u540c\u6b65"}</strong>
        · \u6700\u8fd1\u4e00\u5206\u949f\u63a5\u53e3\u6743\u91cd <strong>{liveStatus.lastWeight}</strong>
        · \u672c\u5206\u949f\u5df2\u53d1\u9001\u6302\u5355 <strong>{liveStatus.ordersThisMinute}</strong> \u7b14
      </div>}
      {isLive && state.liveAccount && <div className="exec-accounts">
        <div className="exec-account"><span className="asset-name">USDT \u94b1\u5305</span><div className="wallet">{Number(walletUSDT?.walletBalance ?? state.liveAccount.totalWalletBalance).toLocaleString("en-US", { maximumFractionDigits: 4 })}<small> USDT</small></div><div className="meta"><span>\u53ef\u7528 {Number(walletUSDT?.availableBalance ?? state.liveAccount.availableBalance).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span><span>\u672a\u5b9e\u73b0\u76c8\u4e8f {Number(walletUSDT?.unrealizedProfit ?? "0").toFixed(2)}</span></div></div>
        <div className="exec-account"><span className="asset-name">USDC \u94b1\u5305</span><div className="wallet">{Number(walletUSDC?.walletBalance ?? "0").toLocaleString("en-US", { maximumFractionDigits: 4 })}<small> USDC</small></div><div className="meta"><span>\u53ef\u7528 {Number(walletUSDC?.availableBalance ?? "0").toLocaleString("en-US", { maximumFractionDigits: 2 })}</span><span>\u672a\u5b9e\u73b0\u76c8\u4e8f {Number(walletUSDC?.unrealizedProfit ?? "0").toFixed(2)}</span></div></div>
      </div>}
      {!isLive && <div className="cred-config" style={{ border: "1px solid #2b3439", borderRadius: 6, padding: "12px 14px", background: "#161c20", marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: "#8c9c9c", marginBottom: 8 }}>实盘交易凭据（页面填写，保存到本机）</div>
        <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 1fr", gap: 8 }}>
          <select aria-label="实盘环境" value={credEnv} onChange={e => setCredEnv(e.target.value as "demo" | "production")} disabled={busy} style={{ padding: "8px 10px", background: "#11171b", color: "#e3e8eb", border: "1px solid #344037", borderRadius: 4, fontSize: 12 }}>
            <option value="demo">Binance Demo 测试环境</option>
            <option value="production">币安正式环境</option>
          </select>
          <input aria-label="交易 API Key" type="password" value={apiKeyText} onChange={e => setApiKeyText(e.target.value)} placeholder={credInfo?.configured ? ("已配置 Key …" + (credInfo.keyTail ?? "") + "（留空保留）") : "BINANCE_LIVE_API_KEY"} autoComplete="off" spellCheck={false} disabled={busy} style={{ padding: "9px 11px", background: "#11171b", color: "#e3e8eb", border: "1px solid #344037", borderRadius: 4, fontFamily: "monospace", fontSize: 12 }} />
          <input aria-label="交易 API Secret" type="password" value={apiSecretText} onChange={e => setApiSecretText(e.target.value)} placeholder="BINANCE_LIVE_API_SECRET" autoComplete="new-password" spellCheck={false} disabled={busy} style={{ padding: "9px 11px", background: "#11171b", color: "#e3e8eb", border: "1px solid #344037", borderRadius: 4, fontFamily: "monospace", fontSize: 12 }} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <button className="button primary" onClick={() => void saveCred()} disabled={busy || savingCred || (!apiKeyText && !apiSecretText && !!credInfo?.configured)}><CheckCheck size={14} />保存凭据</button>
          {credInfo?.configured && <button className="button secondary" onClick={() => void clearCred()} disabled={busy || savingCred}><Trash2 size={14} />清除</button>}
          <span style={{ fontSize: 10, color: "#637077" }}>{credInfo?.configured ? ("当前：来自 " + (credInfo.source === "env" ? ".env 环境变量" : credInfo.source === "file" ? "页面保存" : "未知") + " · " + (credInfo.environment === "production" ? "正式环境" : "Demo") + (credInfo.savedAt ? " · 保存于 " + time(credInfo.savedAt) : "")) : (credInfo?.configurationIssue ?? "尚未配置实盘凭据")}</span>
        </div>
        <div className="exec-hint" style={{ marginTop: 8 }}>凭据仅保存在本机数据目录（live-credentials.json，权限 600），仅本机工作台可读；Key/Secret 留空保存会保留原有值。</div>
      </div>}
      <div className="exec-actions">
        {isLive ? <>
          <button className="button secondary" onClick={() => void switchMode("paper")} disabled={busy || state.executionStatus === "switching"}><Pause size={14} />\u5207\u6362\u56de\u672c\u5730\u6a21\u62df</button>
        </> : <>
          <input aria-label="\u8f93\u5165\u0020\u0045\u004e\u0041\u0042\u004c\u0045\u0020\u004c\u0049\u0056\u0045\u0020\u0054\u0052\u0041\u0044\u0049\u004e\u0047\u0020\u786e\u8ba4\u5b9e\u76d8\u4ea4\u6613" value={liveConfirm} onChange={e => setLiveConfirm(e.target.value)} placeholder="ENABLE LIVE TRADING" autoComplete="off" spellCheck={false} disabled={busy} style={{ flex: 1, padding: "9px 11px", background: "#11171b", color: "#e3e8eb", border: "1px solid #344037", borderRadius: 4, fontFamily: "monospace", fontSize: 12 }} />
          <button className="button primary" onClick={() => void switchMode("live")} disabled={busy || state.executionStatus === "switching" || liveConfirm !== "ENABLE LIVE TRADING"}><Zap size={14} />\u542f\u7528\u5b9e\u76d8</button>
        </>}
      </div>
      {liveStatus?.configurationIssue && <div className="exec-hint warning">{liveStatus.configurationIssue}</div>}
      <div className="exec-hint">\u5b9e\u76d8\u4ea4\u6613\u4ec5\u53d1\u9001\u0020\u0050\u006f\u0073\u0074\u002d\u006f\u006e\u006c\u0079\u0020\u0047\u0054\u0058\u0020\u9650\u4ef7\u5355\uff1b\u51cf\u4ed3\u5355\u9ed8\u8ba4\u5e26 <code>reduceOnly</code>\u3002\u8fd0\u884c\u4e2d\u53ef\u70b9\u51fb\u4e0a\u65b9"\u7d27\u6025\u505c\u6b62"\u64a4\u9500\u6240\u6709\u6302\u5355\u3002</div>
    </div>
  </section>;
}

function Guide({ state, command, onReset, busy }: { state: AppState; command: Command; onReset: () => void; busy: boolean }) {
  return <><LiveTradingPanel state={state} command={command} busy={busy} /><section className="panel environment-panel"><PanelHeading title="行情来源" description="行情一律来自币安 USDⓈ-M 永续合约公开接口，不做本地模拟。" /><div className="environment-options"><button className="environment-option selected" disabled><Globe2 size={25} /><span><strong>币安公开行情</strong><small>实时盘口、标记价格与 24h 成交额。</small></span><span className="radio-circle"><i /></span></button></div><div className="inline-note"><CircleHelp size={16} /><span>公开接口可能受地区或网络限制；失败时系统会显示错误并停止报价。启用实盘后，挂单与撤单直接发送到币安。</span></div></section>
    <div className="guide-grid"><section className="panel guide-card"><span className="guide-number">01</span><h2>客户说的这些词，是什么意思？</h2><dl><dt>U 本位</dt><dd>用 USDT 或 USDC 作为保证金币种。本系统分开记账，不把两种余额混用。</dd><dt>Maker / 只挂单</dt><dd>把限价单放在盘口等待别人来成交。报价不穿过对手盘，使用 Post-only / GTX 语义；不会主动吃单。</dd><dt>每格 U 金额与「张数」</dt><dd>每格 U 是名义成交金额。币数量 = U 金额 ÷ 限价，再按币种步长向下取整。「张」是自定义数量单位，需指定一张等于多少基础币。</dd><dt>撤单、挂单、追单</dt><dd>撤掉尚未成交的剩余量，再按新盘口重新挂限价单。追价有最小时间间隔和全局操作额度，不做无意义的高频撤改单。</dd></dl></section><section className="panel guide-card"><span className="guide-number">02</span><h2>从配置到运行，只需四步</h2><ol className="guide-steps"><li><span>1</span><div><strong>选择币种与每格金额</strong><p>从榜单选择合约，每币独立建策略；检查预览里的币数量与保证金。</p></div></li><li><span>2</span><div><strong>设定移动网格</strong><p>例如 BTC 中心价上下各 400 U、18 格，每 30 分钟移动中心；突破区间也会触发调整。</p></div></li><li><span>3</span><div><strong>先检查风险上限</strong><p>同时配置单笔、挂单总量、单边持仓、亏损和 10 秒波动限制。</p></div></li><li><span>4</span><div><strong>启动挂单并观察</strong><p>保存配置后启动机器人，在真实行情下观察挂单、持仓与风控状态。</p></div></li></ol></section></div>
    <section className="panel execution-guide"><PanelHeading title="这版系统的执行边界" /><div className="guide-boundaries"><div><ShieldCheck size={22} /><h3>只减仓，不反向开仓</h3><p>减仓单标记 Reduce-only，每次部分成交都重新限制数量。暂停、熔断和紧急停止都会保留未平持仓。</p></div><div><Clock3 size={22} /><h3>成交取决于市场</h3><p>仅挂 Post-only 限价单，等对手方吃单才会成交。不包含资金费率、滑点与交易所撮合细节；极端行情下可能一直不成交。</p></div><div><CircleAlert size={22} /><h3>不能保证止损成交</h3><p>极端行情下只挂单可能一直不成交。此版本不承诺盈利、避免爆仓或零手续费；不提供对敲、虚假刷量或制造虚假流动性的功能。</p></div></div><div className="docs-links"><span>官方概念参考</span><External href="https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information">合约交易规则</External><External href="https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order">订单与 GTX 参数</External><External href="https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/24hr-Ticker-Price-Change-Statistics">24h 行情</External></div></section>
    <section className="panel data-management"><div><h2>数据管理</h2><p>数据保存在本机。重启后保留策略与成交记录，机器人自动暂停。可导出当前快照留档。</p></div><div className="heading-actions"><a className="button secondary" href="/api/export" download><Download size={15} />导出记录</a><button className="button danger-ghost" onClick={onReset} disabled={busy}><RefreshCw size={15} />重置工作台数据</button></div></section>
  </>;
}

function RobotDetail({ robot, state, onClose, onEdit, onDelete, onAction, busy }: { robot: Robot; state: AppState; onClose: () => void; onEdit: () => void; onDelete: () => void; onAction: (action: 'start' | 'pause' | 'reduce') => void; busy: boolean }) {
  const [tab, setTab] = useState<'orders' | 'fills' | 'config'>('orders');
  const market = state.markets.find(m => m.symbol === robot.symbol);
  const orders = state.orders.filter(o => o.robotId === robot.id);
  const fills = state.fills.filter(f => f.robotId === robot.id);
  const buys = orders.filter(o => o.side === 'BUY').sort((a, b) => Number(b.price) - Number(a.price));
  const sells = orders.filter(o => o.side === 'SELL').sort((a, b) => Number(a.price) - Number(b.price));
  const live = robot.status === 'running' || robot.status === 'reduce_only';
  const hasPosition = Number(robot.positionQty) !== 0;
  const pnl = market ? (Number(market.markPrice) - Number(robot.entryPrice)) * Number(robot.positionQty) : 0;
  return <Modal title={robot.name} eyebrow="STRATEGY DETAIL" onClose={onClose} drawer><div className="detail-body"><div className="detail-identity"><CoinIcon base={market?.baseAsset ?? robot.symbol.replace(/USDC$|USDT$/, '')} /><div><h3>{robot.symbol}</h3><span>永续 · U 本位 · {robot.leverage}×</span></div><Status value={robot.status} /></div><div className={`robot-reason ${robot.status === 'cooldown' ? 'warning' : ''}`}><ShieldCheck size={16} /><span>{robot.reason}{robot.cooldownUntil > state.now && `（冷却剩余 ${Math.ceil((robot.cooldownUntil - state.now) / 1000)} 秒）`}</span></div><div className="detail-actions"><button className="button primary" disabled={busy || state.emergencyStopped} onClick={() => onAction(live ? 'pause' : 'start')}>{live ? <Pause size={14} /> : <Play size={14} />}{live ? '暂停并撤单' : '启动'}</button><button className="button secondary" onClick={() => onAction('reduce')} disabled={busy || !hasPosition || state.emergencyStopped}><ArrowDownToLine size={14} />只减仓</button><button className="button secondary" onClick={onEdit}><SlidersHorizontal size={14} />编辑参数</button></div><div className="detail-stats"><div><span>当前持仓</span><strong>{hasPosition ? `${Number(robot.positionQty) > 0 ? '多' : '空'} ${money(Math.abs(Number(robot.positionQty)), 6)}` : '无持仓'}</strong><small>{hasPosition ? `均价 ${price(robot.entryPrice)}` : '等待网格成交'}</small></div><div><span>浮动盈亏</span><strong className={pnl >= 0 ? 'positive' : 'negative'}>{signed(pnl)} U</strong><small>已实现净收益 {signed(robot.realizedPnl)} U</small></div><div><span>累计成交</span><strong>{robot.fillCount} <small>笔</small></strong><small>名义金额 {money(robot.filledNotional)} U</small></div><div><span>已付手续费</span><strong>{money(robot.fees, 4)} <small>U</small></strong><small>配置费率 {robot.makerFeeBps} bps</small></div></div><div className="detail-tabs"><button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>当前委托 <b>{orders.length}</b></button><button className={tab === 'fills' ? 'active' : ''} onClick={() => setTab('fills')}>成交记录</button><button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>策略参数</button></div>
      {tab === 'orders' && <><div className="book-heading"><span className="positive">买单 ({buys.length})</span><span>价格 / 剩余币数量</span><span className="negative">卖单 ({sells.length})</span></div><div className="book-balance"><i style={{ flex: buys.length || 1 }} /><i style={{ flex: sells.length || 1 }} /></div>{orders.length ? <div className="order-book">{Array.from({ length: Math.max(buys.length, sells.length) }, (_, i) => <div className="book-row" key={i}><div className="buy-cell">{buys[i] && <><b>{price(buys[i].price)}</b><span>{buys[i].remaining}{buys[i].reduceOnly && ' · 只减仓'}</span></>}</div><em>{i + 1}</em><div className="sell-cell">{sells[i] && <><b>{price(sells[i].price)}</b><span>{sells[i].remaining}{sells[i].reduceOnly && ' · 只减仓'}</span></>}</div></div>)}</div> : <Empty title="当前没有挂单" detail={robot.status === 'paused' ? '启动机器人后查看双向 Maker 委托' : robot.reason} />}<p className="detail-caption">所有订单均为 Post-only GTX 限价单。部分成交后这里只显示剩余币数量。</p></>}
      {tab === 'fills' && <>{fills.length ? <div className="fill-list">{fills.slice(0, 50).map(f => <div className="fill-entry" key={f.id}><span className={`fill-side ${f.side === 'BUY' ? 'buy' : 'sell'}`}>{f.side === 'BUY' ? '买' : '卖'}</span><div><strong>{f.quantity} @ {price(f.price)}</strong><small>{time(f.time)} · Maker</small></div><div><strong className={Number(f.realizedPnl) >= 0 ? 'positive' : 'negative'}>{signed(f.realizedPnl, 4)} U</strong><small>手续费 {money(f.fee, 4)} U</small></div></div>)}</div> : <Empty title="还没有成交" detail="只有后续盘口越过挂单价格时，挂单才会被对手方吃单成交" />}<p className="detail-caption">本页最多展示最近 50 笔；导出记录可查看更多。纸面模式下成交不代表实际账户盈亏。</p></>}
      {tab === 'config' && <dl className="config-list">{[
        ['每格方式', SIZING_LABELS[robot.sizingMode]], ['每格下单量', `${robot.orderSize}${robot.sizingMode.endsWith('_pct') ? '%' : robot.sizingMode === 'quote' ? ' U' : robot.sizingMode === 'contracts' ? ` 张（每张 ${robot.contractSize} 币）` : ' 币'}`], ['网格 / 半区间', `${robot.gridCount} 格 / ±${robot.halfRange} ${robot.rangeMode === 'fixed' ? 'U' : 'bps'}`], ['移动网格中心', `每 ${robot.recenterMinutes} 分钟 / 突破区间`], ['报价最小间隔 / 有效期', `${robot.repriceSeconds} 秒 / ${robot.orderTtlSeconds} 秒`], ['平多 / 平空偏移', `${robot.closeLongOffset} / ${robot.closeShortOffset} ${robot.closeOffsetMode === 'fixed' ? 'U' : 'bps'}`], ['持仓 / 开仓挂单上限', `${robot.maxPositionNotional} / ${robot.maxOpenNotional} U`], ['单笔上限', `${robot.maxOrderNotional} U`], ['累计净亏损上限', `${robot.stopLossQuote} U`], ['10 秒波动熔断', `${robot.shockPercent}%`], ['冷却时间', `${robot.cooldownSeconds} 秒，手动恢复`], ['创建时间', shortDate(robot.createdAt)],
      ].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
    </div><div className="drawer-footer"><span><Shield size={13} />暂停或撤单不会平仓</span><button className="text-button negative" onClick={onDelete} disabled={hasPosition}><Trash2 size={14} />删除机器人</button></div></Modal>;
}
