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

export function External({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-link">{children}<ArrowUpRight size={14} /></a>;
}
