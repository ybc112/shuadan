import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronDown, CircleHelp, Layers3, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { Instrument, Market, Robot, RobotConfig, SizingMode } from '../shared/types';
import { SIZING_LABELS } from '../shared/types';
import { defaultConfig, robotSchema } from '../shared/config';
import { api } from './api';
import { CoinIcon, Modal, money, price } from './components';

interface Preview {
  levels: { side: 'BUY' | 'SELL'; price: string; quantity: string; notional: string }[];
  totalNotional: string;
  estimatedMargin: string;
  referencePrice: string;
  instrument: Instrument;
  budgetLimited: boolean;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Numeric({ label, value, onChange, unit, hint, step = 'any', min, max }: {
  label: string; value: number; onChange: (value: number) => void; unit?: string; hint?: string; step?: string | number; min?: number; max?: number;
}) {
  const id = useId();
  return <label className="field" htmlFor={id}><span className="field-label">{label}</span><div className="input-unit"><input id={id} type="number" inputMode="decimal" value={Number.isFinite(value) ? value : ''}
    onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} step={step} min={min} max={max} />{unit && <span>{unit}</span>}</div>{hint && <small>{hint}</small>}</label>;
}

export function RobotForm({ markets, initial, editing, onClose, onSaved }: {
  markets: Market[]; initial: RobotConfig; editing?: Robot; onClose: () => void; onSaved: (message: string) => Promise<void>;
}) {
  const keys = Object.keys(robotSchema.innerType().shape) as (keyof RobotConfig)[];
  const [config, setConfig] = useState<RobotConfig>(() => Object.fromEntries(keys.map(key => [key, initial[key]])) as unknown as RobotConfig);
  const [tab, setTab] = useState(0);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const market = markets.find(m => m.symbol === config.symbol);
  const [asset, setAsset] = useState(market?.quoteAsset ?? 'USDC');
  const update = <K extends keyof RobotConfig>(key: K, value: RobotConfig[K]) => setConfig(current => ({ ...current, [key]: value }));
  useEffect(() => {
    let active = true;
    setPreviewing(true);
    const timeout = setTimeout(async () => {
      const validated = robotSchema.safeParse(config);
      if (!validated.success) {
        if (active) { setPreviewError(validated.error.issues[0].message); setPreviewing(false); setPreview(null); }
        return;
      }
      try {
        const result = await api<Preview>('/preview', 'POST', config);
        if (active) { setPreview(result); setPreviewError(''); }
      } catch (error) { if (active) { setPreview(null); setPreviewError(error instanceof Error ? error.message : '预览失败'); } }
      finally { if (active) setPreviewing(false); }
    }, 350);
    return () => { active = false; clearTimeout(timeout); };
  }, [config]);

  const chooseMarket = (symbol: string) => {
    const next = markets.find(m => m.symbol === symbol);
    if (next) setConfig(defaultConfig(next));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError('');
    const validated = robotSchema.safeParse(config);
    if (typeof console !== 'undefined' && !(window as unknown as { __makerLoggedConfig?: boolean }).__makerLoggedConfig) { (window as unknown as { __makerLoggedConfig?: boolean }).__makerLoggedConfig = true; console.log('[maker] form config:', config); }
    if (!validated.success) { setError(validated.error.issues.map(i => i.message).join('；')); return; }
    setSaving(true);
    try {
      await api(editing ? `/robots/${editing.id}` : '/robots', editing ? 'PUT' : 'POST', config);
      await onSaved(editing ? '参数已保存，旧挂单已撤销，机器人已暂停' : '机器人已创建，复核后即可启动');
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };

  const sizeUnit = config.sizingMode === 'quote' ? asset : config.sizingMode.endsWith('_pct') ? '%' : config.sizingMode === 'contracts' ? '张' : market?.baseAsset;
  return <Modal title={editing ? '编辑机器人' : '创建 Maker 机器人'} eyebrow={editing ? 'EDIT STRATEGY' : 'NEW STRATEGY'} onClose={onClose} wide>
    <form onSubmit={submit} noValidate>
      <div className="form-layout">
        <div className="form-main">
          <div className="form-tabs">{['基础设置', '网格与追价', '仓位与风控'].map((text, i) => <button type="button" key={text} className={tab === i ? 'active' : ''} onClick={() => setTab(i)}><span>{i + 1}</span>{text}</button>)}</div>
          {tab === 0 && <div className="form-fields">
            <Field label="机器人名称"><input value={config.name} maxLength={40} onChange={e => update('name', e.target.value)} placeholder="例如 BTC 稳健移动网格" /></Field>
            <div className="field"><span className="field-label">保证金币种 · U 本位永续</span><div className="segmented asset-segment">{(['USDC', 'USDT'] as const).map(a => <button type="button" key={a} disabled={!!editing} className={asset === a ? 'selected' : ''} onClick={() => { setAsset(a); const m = markets.filter(m => m.quoteAsset === a).sort((a, b) => b.quoteVolume - a.quoteVolume)[0]; if (m) chooseMarket(m.symbol); }}>{a}<span>{a === 'USDC' ? 'USD Coin' : 'Tether'}</span></button>)}</div></div>
            <Field label="交易合约" hint="一个合约创建一个机器人，参数独立设置。"><div className="select-wrap"><select value={config.symbol} disabled={!!editing} onChange={e => chooseMarket(e.target.value)}>{markets.filter(m => m.quoteAsset === asset).sort((a, b) => b.quoteVolume - a.quoteVolume).map(m => <option key={m.symbol} value={m.symbol}>{m.symbol} · 永续</option>)}</select><ChevronDown size={15} /></div></Field>
            <div className="field-grid">
              <Field label="每格下单方式"><select value={config.sizingMode} onChange={e => {
                const mode = e.target.value as SizingMode;
                setConfig(c => ({ ...c, sizingMode: mode, orderSize: mode.endsWith('_pct') ? 0.5 : mode === 'base' ? Number(market?.quantityStep ?? 1) * 10 : mode === 'contracts' ? 10 : 120 }));
              }}>{Object.entries(SIZING_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
              <Numeric label="每格下单量" value={config.orderSize} onChange={v => update('orderSize', v)} unit={sizeUnit} min={0} />
            </div>
            {config.sizingMode === 'contracts' && <Numeric label="自定义每张币数量" value={config.contractSize} onChange={v => update('contractSize', v)} unit={market?.baseAsset} hint="1 张对应的基础币数量由你定义；币安 U 本位接口实际使用币数量，并无统一张面值。" />}
            <div className="field-grid"><Numeric label="杠杆" value={config.leverage} onChange={v => update('leverage', v)} unit="×" step={1} min={1} max={10} hint="范围 1–10 倍" /><Numeric label="Maker 手续费" value={config.makerFeeBps} onChange={v => update('makerFeeBps', v)} unit="bps" min={0} hint="2 bps = 0.02%，不假设零费率" /></div>
            <div className="inline-note"><CircleHelp size={16} /><span>U 金额和账户百分比均指每格的名义金额；杠杆只改变保证金占用。数量会按该币的步长向下取整。</span></div>
          </div>}
          {tab === 1 && <div className="form-fields">
            <div className="field-grid"><Numeric label="网格总数" value={config.gridCount} onChange={v => update('gridCount', v)} unit="格" min={2} max={60} step={2} hint="2–60 格，买卖两侧各一半" /><Numeric label="定时移动网格中心" value={config.recenterMinutes} onChange={v => update('recenterMinutes', v)} unit="分钟" min={1} max={1440} step={1} hint="价格突破区间时也会重设中心" /></div>
            <div className="field-grid"><Field label="网格区间方式"><select value={config.rangeMode} onChange={e => update('rangeMode', e.target.value as 'fixed' | 'bps')}><option value="bps">比例范围</option><option value="fixed">固定价差</option></select></Field><Numeric label="中心价上下各偏移" value={config.halfRange} onChange={v => update('halfRange', v)} unit={config.rangeMode === 'fixed' ? asset : 'bps'} min={0} hint={config.rangeMode === 'fixed' ? '例如 BTC 上下各 400 U' : '100 bps = 1%'} /></div>
            <div className="field-grid"><Numeric label="最小撤改重报间隔" value={config.repriceSeconds} onChange={v => update('repriceSeconds', v)} unit="秒" min={5} max={3600} step={1} hint="至少 5 秒，风险撤单立即执行" /><Numeric label="挂单有效期" value={config.orderTtlSeconds} onChange={v => update('orderTtlSeconds', v)} unit="秒" min={10} max={86400} step={1} hint="1800 秒 = 30 分钟" /></div>
            <div className="form-divider"><span>只减仓追价</span><span className="tag">Reduce-only</span></div>
            <Field label="减仓偏移方式"><select value={config.closeOffsetMode} onChange={e => update('closeOffsetMode', e.target.value as 'fixed' | 'bps')}><option value="bps">相对盘口中间价 · 比例</option><option value="fixed">相对盘口中间价 · 固定价差</option></select></Field>
            <div className="field-grid"><Numeric label="平多卖单上偏移" value={config.closeLongOffset} onChange={v => update('closeLongOffset', v)} unit={config.closeOffsetMode === 'bps' ? 'bps' : asset} min={0} /><Numeric label="平空买单下偏移" value={config.closeShortOffset} onChange={v => update('closeShortOffset', v)} unit={config.closeOffsetMode === 'bps' ? 'bps' : asset} min={0} /></div>
            <div className="inline-note"><Layers3 size={16} /><span>报价会按买一 / 卖一修正为被动价格，先撤后挂。只追限价，不转市价，也不保证平仓成功。</span></div>
          </div>}
          {tab === 2 && <div className="form-fields">
            <div className="field-grid"><Numeric label="最大持仓名义金额" value={config.maxPositionNotional} onChange={v => update('maxPositionNotional', v)} unit={asset} min={5} hint="单边可能全部成交的挂单也计入校验" /><Numeric label="最大开仓挂单总额" value={config.maxOpenNotional} onChange={v => update('maxOpenNotional', v)} unit={asset} min={5} hint="买卖两侧合计，避免重复占用资金" /></div>
            <div className="field-grid"><Numeric label="单笔最大名义金额" value={config.maxOrderNotional} onChange={v => update('maxOrderNotional', v)} unit={asset} min={5} /><Numeric label="机器人累计净亏损上限" value={config.stopLossQuote} onChange={v => update('stopLossQuote', v)} unit={asset} min={1} hint="包含已实现收益、浮动盈亏和手续费" /></div>
            <div className="field-grid"><Numeric label="10 秒波动熔断阈值" value={config.shockPercent} onChange={v => update('shockPercent', v)} unit="%" min={0.1} max={10} /><Numeric label="熔断冷却时间" value={config.cooldownSeconds} onChange={v => update('cooldownSeconds', v)} unit="秒" min={10} max={86400} step={1} hint="冷却结束后仍需手动恢复" /></div>
            <div className="protection-note"><ShieldCheck size={23} /><div><strong>单边仓位保护</strong><p>持仓达到上限的 80% 时停止增加风险，转为只减仓。全局资金和风控限制同时生效。</p></div></div>
            <div className="inline-note warning"><CircleHelp size={16} /><span>行情跳空时，已有挂单可能先成交再触发撤单。无市价兜底无法保证止损或避免强平。</span></div>
          </div>}
        </div>
        <aside className="form-preview">
          <span className="eyebrow">ORDER PREVIEW</span><h3>先看清，再启动</h3>
          <div className="preview-market"><CoinIcon base={market?.baseAsset ?? 'BTC'} /><div><strong>{config.symbol}</strong><span>U 本位 · 永续合约</span></div></div>
          <div className="preview-price"><span>参考中间价</span><strong>{preview ? price(preview.referencePrice) : '—'} <small>{asset}</small></strong></div>
          <div className="preview-ladder" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <div key={i} className={i < 3 ? 'ask' : i === 3 ? 'mid' : 'bid'}><i style={{ width: `${35 + Math.abs(i - 3) * 16}%` }} /><span>{i < 3 ? 'SELL' : i === 3 ? 'MID PRICE' : 'BUY'}</span></div>)}</div>
          <div className="preview-values"><div><span>首个买格币数量</span><strong>{preview?.levels[0]?.quantity ?? '—'} <small>{market?.baseAsset}</small></strong></div><div><span>全部网格名义金额</span><strong>{preview ? money(preview.totalNotional) : '—'} <small>U</small></strong></div><div><span>预估保证金</span><strong>{preview ? money(preview.estimatedMargin) : '—'} <small>{asset}</small></strong></div></div>
          {previewing ? <p className="preview-state"><LoaderCircle className="spin" size={14} />正在校验下单规则</p> : previewError ? <p className="preview-state negative">{previewError}</p> : <p className="preview-state positive"><Check size={14} />币种精度与最小金额校验通过</p>}
          {preview?.budgetLimited && <p className="small-warning">完整网格超出当前预算，启动时只会挂出预算允许的订单。</p>}
          {market && <div className="instrument-rules"><span>价格步长 <b>{market.priceTick}</b></span><span>数量步长 <b>{market.quantityStep}</b></span><span>最小名义金额 <b>{market.minNotional} U</b></span></div>}
          <p className="preview-footer">创建后保持暂停。预估不包含资金费率、排队位置和交易所强平机制；启用实盘后按真实账户执行。</p>
        </aside>
      </div>
      {error && <div className="form-error" role="alert" style={{ position: 'sticky', top: 0, zIndex: 5, fontSize: 12, padding: '10px 14px', border: '1px solid #b94a3a', background: '#3a1e1c', color: '#ffd9d4', borderRadius: 6, marginBottom: 12 }}><strong>无法创建机器人：</strong>{error}</div>}
      <div className="modal-footer"><span><ShieldCheck size={14} />按当前执行模式发送订单（纸面或实盘）</span><div><button className="button secondary" type="button" onClick={onClose}>取消</button>{tab < 2 && <button className="button secondary" type="button" onClick={() => setTab(t => t + 1)}>下一步<ArrowRight size={14} /></button>}<button className="button primary" type="submit" disabled={saving || !!previewError || previewing || !Number.isFinite(config.orderSize) || !Number.isFinite(config.contractSize) || !Number.isFinite(config.halfRange) || !Number.isFinite(config.leverage) || !Number.isFinite(config.maxPositionNotional) || !Number.isFinite(config.maxOpenNotional) || !Number.isFinite(config.maxOrderNotional) || !Number.isFinite(config.stopLossQuote) || !Number.isFinite(config.shockPercent) || !Number.isFinite(config.cooldownSeconds) || !Number.isFinite(config.makerFeeBps) || !Number.isFinite(config.recenterMinutes) || !Number.isFinite(config.repriceSeconds) || !Number.isFinite(config.orderTtlSeconds) || !Number.isFinite(config.closeLongOffset) || !Number.isFinite(config.closeShortOffset)}>{saving && <LoaderCircle size={15} className="spin" />}{editing ? '保存并暂停' : '创建机器人'}</button></div></div>
    </form>
  </Modal>;
}
