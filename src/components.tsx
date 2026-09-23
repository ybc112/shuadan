import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowUpRight, X } from 'lucide-react';
import type { Market, Order, RobotStatus } from '../shared/types';
import { STATUS_LABELS } from '../shared/types';

export const money = (value: number | string, digits = 2) => Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const price = (value: number | string) => money(value, Number(value) >= 1000 ? 2 : Number(value) >= 1 ? 3 : 5);
export const compact = (value: number) => value >= 1e8 ? `${money(value / 1e8)} 亿` : value >= 1e4 ? `${money(value / 1e4)} 万` : money(value);
export const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
export const shortDate = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });
export const signed = (value: number | string, digits = 2) => `${Number(value) > 0 ? '+' : ''}${money(value, digits)}`;

const coins: Record<string, { color: string; symbol: string }> = {
  BTC: { color: '#efae54', symbol: '₿' }, ETH: { color: '#b1b9e8', symbol: 'Ξ' },
  SOL: { color: '#a4e3cb', symbol: '≋' }, BNB: { color: '#e6c05a', symbol: '◇' },
  XRP: { color: '#dbe1e5', symbol: '×' }, DOGE: { color: '#d6c27b', symbol: 'Ð' },
  SUI: { color: '#8bc7e8', symbol: 'S' }, ARB: { color: '#90b8e8', symbol: 'A' },
  NEAR: { color: '#bfc9c1', symbol: 'N' }, AVAX: { color: '#e68f92', symbol: 'A' },
};

export function CoinIcon({ base, small = false }: { base: string; small?: boolean }) {
  const coin = coins[base] ?? { color: '#a9b8d5', symbol: base.slice(0, 1) };
  return <span className={`coin-icon ${small ? 'small' : ''}`} style={{ '--coin-color': coin.color } as React.CSSProperties}>{coin.symbol}</span>;
}

export function Status({ value }: { value: RobotStatus }) {
  return <span className={`status status-${value}`}><i />{STATUS_LABELS[value]}</span>;
}

export function Empty({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return <div className="empty"><Activity size={30} strokeWidth={1.3} /><strong>{title}</strong>{detail && <p>{detail}</p>}{children}</div>;
}

export function Modal({ title, eyebrow, children, onClose, wide = false, drawer = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean; drawer?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const id = useId();
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('button, input, select')?.focus());
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(n => n.getClientRects().length);
        if (!nodes.length) return;
        if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes[nodes.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === nodes[nodes.length - 1]) { e.preventDefault(); nodes[0].focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', key); prior?.focus(); };
  }, []);
  return <div className={`modal-backdrop ${drawer ? 'drawer-backdrop' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'wide' : ''} ${drawer ? 'drawer' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={id}>
      <div className="modal-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id={id}>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭窗口"><X size={20} /></button></div>
      {children}
    </div>
  </div>;
}

export function Sparkline({ values, positive = true }: { values: number[]; positive?: boolean }) {
  if (values.length < 2) return <svg viewBox="0 0 100 28" className="sparkline" aria-hidden="true"><path d="M0 15 H100" stroke="currentColor" fill="none" /></svg>;
  const min = Math.min(...values), span = Math.max(...values) - min || 1;
  const points = values.map((v, i) => `${i / (values.length - 1) * 100},${25 - (v - min) / span * 22}`).join(' ');
  return <svg viewBox="0 0 100 28" className={`sparkline ${positive ? 'positive' : 'negative'}`} aria-hidden="true"><polyline points={points} stroke="currentColor" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" /></svg>;
}

export function PriceChart({ market, orders, seconds = 180 }: { market: Market; orders: Order[]; seconds?: number }) {
  const gradient = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const end = market.history[market.history.length - 1]?.time ?? market.updatedAt;
  const history = market.history.filter(h => h.time >= end - seconds * 1000);
  if (history.length < 2) return <Empty title="正在积累行情" detail="收到至少两个行情快照后显示价格曲线" />;
  const values = history.map(h => h.price), latest = values[values.length - 1]!;
  const nearestBuy = orders.filter(o => o.side === 'BUY').sort((a, b) => Number(b.price) - Number(a.price))[0];
  const nearestSell = orders.filter(o => o.side === 'SELL').sort((a, b) => Number(a.price) - Number(b.price))[0];
  const all = [...values, ...[nearestBuy, nearestSell].filter(Boolean).map(o => Number(o!.price))];
  const min = Math.min(...all), max = Math.max(...all), padding = Math.max((max - min) * 0.22, latest * 0.0001);
  const low = min - padding, high = max + padding;
  const W = 760, H = 236, left = 5, right = 85, top = 12, bottom = 30;
  const x = (index: number) => left + index / (history.length - 1) * (W - left - right);
  const y = (value: number) => top + (high - value) / (high - low) * (H - top - bottom);
  const line = history.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(h.price).toFixed(2)}`).join(' ');
  const hovered = hover !== null ? history[Math.min(history.length - 1, hover)] : null;
  return <div className="price-chart">
    {hovered && <div className="chart-tooltip">{time(hovered.time)} <strong>{price(hovered.price)}</strong></div>}
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${market.symbol} 最近 ${seconds} 秒标记价格曲线，虚线代表最近的买卖挂单`} onMouseLeave={() => setHover(null)} onMouseMove={e => {
      const rect = e.currentTarget.getBoundingClientRect();
      const offset = (e.clientX - rect.left) / rect.width * W;
      setHover(Math.max(0, Math.min(history.length - 1, Math.round((offset - left) / (W - left - right) * (history.length - 1)))));
    }}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b6e986" stopOpacity="0.17" /><stop offset="100%" stopColor="#b6e986" stopOpacity="0" /></linearGradient></defs>
      {[0, 1, 2, 3].map(i => { const value = low + (high - low) * i / 3; return <g key={i}><line x1={left} x2={W - right} y1={y(value)} y2={y(value)} className="chart-grid" /><text x={W - right + 12} y={y(value) + 4} className="chart-label">{price(value)}</text></g>; })}
      <path d={`${line} L${x(history.length - 1)},${H - bottom} L${left},${H - bottom} Z`} fill={`url(#${gradient})`} />
      {[nearestBuy, nearestSell].map(o => o && <g key={o.id} className={o.side === 'BUY' ? 'chart-buy' : 'chart-sell'}><line x1={left} x2={W - right} y1={y(Number(o.price))} y2={y(Number(o.price))} /><text x={left + 7} y={y(Number(o.price)) - 5}>{o.side === 'BUY' ? '买' : '卖'} {price(o.price)}</text></g>)}
      <path d={line} fill="none" stroke="#b9e997" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={x(history.length - 1)} cy={y(latest)} r="3.5" fill="#c2ef97" />
      {[0, 0.25, 0.5, 0.75, 1].map(p => { const index = Math.round(p * (history.length - 1)); return <text key={p} x={x(index)} y={H - 4} textAnchor={p === 0 ? 'start' : p === 1 ? 'end' : 'middle'} className="chart-label">{time(history[index].time)}</text>; })}
      {hovered && <g><line x1={x(hover!)} x2={x(hover!)} y1={top} y2={H - bottom} stroke="#6b7770" strokeDasharray="3 3" /><circle cx={x(hover!)} cy={y(hovered.price)} r="4" fill="#e0fbc7" stroke="#151b16" strokeWidth="2" /></g>}
    </svg>
  </div>;
}

export function PanelHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="panel-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{children}</div>;
}

/** 后端 /api/analytics 返回的逐笔成交序列元素 */
export interface TradePoint { ts: number; price: number; buyQty: number; sellQty: number; buyCount: number; sellCount: number; realizedPnl: number; fee: number }
/** 后端 /api/analytics 返回的权益快照元素 */
export interface EquityPoint { ts: number; wallet: number; unrealized: number; marginUsed: number; markPrice: number }

/**
 * 交易分析与收益图表（工作台总览）。
 * 上半：标记价格走势 + 成交散点（买绿/卖红），hover 高亮最近成交。
 * 下半：权益曲线（含未实现盈亏）与累计已实现盈亏、累计返佣。
 */
export function TradeAnalytics({ trades, equity, symbol, hours }: {
  trades: TradePoint[]; equity: EquityPoint[]; symbol: string; hours: number;
}) {
  const points = trades;
  const hasTrades = points.length > 1;
  const hasEquity = equity.length > 1;
  const buyTotal = points.reduce((s, p) => s + p.buyQty, 0);
  const sellTotal = points.reduce((s, p) => s + p.sellQty, 0);
  const buyCount = points.reduce((s, p) => s + p.buyCount, 0);
  const sellCount = points.reduce((s, p) => s + p.sellCount, 0);
  const realized = points.reduce((s, p) => s + p.realizedPnl, 0);
  const fees = points.reduce((s, p) => s + p.fee, 0);
  const realizedCum: number[] = [0];
  for (const p of points) realizedCum.push(realizedCum[realizedCum.length - 1] + p.realizedPnl + p.fee);

  // —— 上半：价格走势 + 成交散点 ——
  const W1 = 760, H1 = 210, left1 = 8, right1 = 82, top1 = 14, bottom1 = 28;
  const first = points[0]?.ts ?? equity[0]?.ts ?? Date.now() - hours * 3600 * 1000;
  const last = points[points.length - 1]?.ts ?? equity[equity.length - 1]?.ts ?? Date.now();
  const t0 = first, t1 = last === first ? first + 1 : last;
  const lowP = points.length ? Math.min(...points.map(p => p.price)) : hasEquity ? Math.min(...equity.map(e => e.markPrice || 0)) : 0;
  const highP = points.length ? Math.max(...points.map(p => p.price)) : hasEquity ? Math.max(...equity.map(e => e.markPrice || 0)) : 0;
  const spanP = Math.max(highP - lowP, highP * 0.004, 1e-9);
  const xp = (ts: number) => left1 + (ts - t0) / (t1 - t0) * (W1 - left1 - right1);
  const yp = (v: number) => top1 + (highP + spanP * 0.12 - v) / ((highP - lowP) + spanP * 0.24) * (H1 - top1 - bottom1);

  // —— 下半：权益曲线 ——
  const W2 = 760, H2 = 170, left2 = 8, right2 = 82, top2 = 12, bottom2 = 24;
  const eqMin = hasEquity ? Math.min(...equity.map(e => e.wallet + e.unrealized)) : 0;
  const eqMax = hasEquity ? Math.max(...equity.map(e => e.wallet + e.unrealized), realizedCum[realizedCum.length - 1]) : 1;
  const spanQ = Math.max(eqMax - eqMin, Math.abs(eqMax) * 0.01, 1e-9);
  const eqPoints = hasEquity ? equity.filter(e => e.ts >= first - 60000) : [];
  const xq = (ts: number) => left2 + (ts - t0) / (t1 - t0) * (W2 - left2 - right2);
  const yq = (v: number) => top2 + (eqMax + spanQ * 0.08 - v) / ((eqMax - eqMin) + spanQ * 0.16) * (H2 - top2 - bottom2);

  const eqLine = eqPoints.map((e, i) => `${i ? 'L' : 'M'}${xq(e.ts).toFixed(2)},${yq(e.wallet + e.unrealized).toFixed(2)}`).join(' ');
  const cumLine = points.map((p, i) => `${i ? 'L' : 'M'}${xp(p.ts).toFixed(2)},${yq(realizedCum[i + 1]).toFixed(2)}`).join(' ');

  return <div className="analytics-grid">
    <div className="analytics-card">
      <div className="analytics-head"><div><strong>买卖成交 · {symbol || '全部交易对'}</strong><span>最近 {hours} 小时 · 买 {buyCount} / 卖 {sellCount} 笔</span></div>
        <div className="analytics-stats"><span className="positive">买入 {buyTotal.toFixed(4)}</span><span className="negative">卖出 {sellTotal.toFixed(4)}</span></div></div>
      {hasTrades ? <div className="analytics-chart">
        <svg viewBox={`0 0 ${W1} ${H1}`} role="img" aria-label={`${symbol} 最近 ${hours} 小时成交分布`}>
          {[0, 1, 2, 3, 4].map(i => { const v = highP + spanP * 0.12 - ((highP - lowP) + spanP * 0.24) * i / 4; return <g key={i}><line x1={left1} x2={W1 - right1} y1={yp(v)} y2={yp(v)} className="chart-grid" /><text x={W1 - right1 + 10} y={yp(v) + 3} className="chart-label">{price(v)}</text></g>; })}
          {[0, 0.25, 0.5, 0.75, 1].map(p => { const ts = t0 + (t1 - t0) * p; return <text key={p} x={xp(ts)} y={H1 - 6} textAnchor={p === 0 ? 'start' : p === 1 ? 'end' : 'middle'} className="chart-label">{time(ts)}</text>; })}
          <path d={points.map((p, i) => `${i ? 'L' : 'M'}${xp(p.ts).toFixed(2)},${yp(p.price).toFixed(2)}`).join(' ')} fill="none" stroke="#b9e997" strokeWidth="1.4" vectorEffect="non-scaling-stroke" opacity="0.85" />
          {points.map((p, i) => p.buyQty > 0 || p.sellQty > 0 ? <g key={i}>
            <circle cx={xp(p.ts)} cy={yp(p.price)} r={p.buyQty > 0 ? 3.2 : 2.6} fill={p.buyQty > 0 ? '#7ddb9c' : '#e58b96'} />
            {(i === points.length - 1) && <circle cx={xp(p.ts)} cy={yp(p.price)} r="5" fill="none" stroke="#e2f7cf" strokeWidth="1.4" />}
          </g> : null)}
        </svg>
      </div> : <Empty title="该范围暂无成交" detail={symbol ? '切换到其他交易对，或等网格成交后查看' : '待成交后展示买卖分布'} />}
      <div className="analytics-foot"><span><i className="dot buy" />买入成交</span><span><i className="dot sell" />卖出成交</span><small>按币安成交流水（trades.db）统计</small></div>
    </div>

    <div className="analytics-card">
      <div className="analytics-head"><div><strong>收益趋势</strong><span>最近 {hours} 小时</span></div>
        <div className="analytics-stats"><span className={realized + fees >= 0 ? 'positive' : 'negative'}>已实现 {signed(realized + fees, 4)}</span></div></div>
      {hasEquity || points.length > 1 ? <div className="analytics-chart">
        <svg viewBox={`0 0 ${W2} ${H2}`} role="img" aria-label="权益与累计收益曲线">
          {[0, 1, 2, 3].map(i => { const v = eqMax + spanQ * 0.08 - ((eqMax - eqMin) + spanQ * 0.16) * i / 3; return <g key={i}><line x1={left2} x2={W2 - right2} y1={yq(v)} y2={yq(v)} className="chart-grid" /><text x={W2 - right2 + 10} y={yq(v) + 3} className="chart-label">{money(v, 2)}</text></g>; })}
          {[0, 0.25, 0.5, 0.75, 1].map(p => { const ts = t0 + (t1 - t0) * p; return <text key={p} x={xq(ts)} y={H2 - 4} textAnchor={p === 0 ? 'start' : p === 1 ? 'end' : 'middle'} className="chart-label">{time(ts)}</text>; })}
          {hasEquity && <path d={eqLine} fill="none" stroke="#9cc7e8" strokeWidth="1.6" vectorEffect="non-scaling-stroke" opacity="0.9" />}
          {points.length > 1 && <path d={cumLine} fill="none" stroke="#e7b46f" strokeWidth="1.6" vectorEffect="non-scaling-stroke" opacity="0.95" />}
          {hasEquity && eqPoints.map((e, i) => i % 20 === 0 && <circle key={i} cx={xq(e.ts)} cy={yq(e.wallet + e.unrealized)} r="1.8" fill="#9cc7e8" opacity="0.5" />)}
        </svg>
      </div> : <Empty title="权益数据为空" detail="实盘运行中每分钟记录一次权益快照" />}
      <div className="analytics-foot"><span><i className="line blue" />账户权益（含浮盈）</span><span><i className="line amber" />累计已实现收益</span><small>含手续费与返佣净额</small></div>
    </div>
  </div>;
}

export function External({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-link">{children}<ArrowUpRight size={14} /></a>;
}
