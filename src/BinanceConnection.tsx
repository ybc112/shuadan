import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Clock3, KeyRound, LoaderCircle, PlugZap, ShieldCheck } from 'lucide-react';
import type { ConnectionCheckStatus, ConnectionStatus } from '../shared/connection';
import { api } from './api';
import { PanelHeading } from './components';

const labels: Record<ConnectionCheckStatus, string> = {
  passed: '通过', warning: '需留意', failed: '未通过', skipped: '未检查', not_implemented: '未实现',
};
const stamp = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const positionSides: Record<string, string> = { BOTH: '单向', LONG: '多仓', SHORT: '空仓' };

export default function BinanceConnection() {
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [includeAccount, setIncludeAccount] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const posting = useRef(false);
  const requestEpoch = useRef(0);
  const running = connection?.running ?? false;

  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || posting.current) return;
      pending = true;
      const epoch = requestEpoch.current;
      try {
        const next = await api<ConnectionStatus>('/binance/status');
        if (active && epoch === requestEpoch.current) { setConnection(next); setLoadError(''); }
      } catch (error) {
        if (active && epoch === requestEpoch.current) setLoadError(error instanceof Error ? error.message : '无法读取连接状态');
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), running ? 1000 : 5000);
    return () => { active = false; clearInterval(timer); };
  }, [running]);

  const start = async () => {
    if (posting.current) return;
    posting.current = true;
    requestEpoch.current++;
    setSubmitting(true); setCommandError('');
    try {
      const next = await api<ConnectionStatus>('/binance/check', 'POST', {
        symbol: symbol.trim().toUpperCase(), includeAccount: includeAccount && !!connection?.credentialsConfigured,
      });
      if (mounted.current) { setConnection(next); setLoadError(''); }
    } catch (error) {
      if (mounted.current) setCommandError(error instanceof Error ? error.message : '无法开始连接检查');
    } finally {
      posting.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const remaining = Math.max(0, Math.ceil(((connection?.nextCheckAt ?? 0) - now) / 1000));
  const report = connection?.lastReport;
  const account = report?.account;
  const validSymbol = /^[A-Z0-9]{3,30}$/.test(symbol.trim());
  return <section className="panel connection-panel" aria-labelledby="connection-title">
    <PanelHeading title="币安 API 连接检查" description="验证真实接口的读取结果，逐项显示可用状态与失败原因">
      <span className="connection-mode"><ShieldCheck size={14} />只读连接</span>
    </PanelHeading>
    <div className="connection-body">
      <h3 id="connection-title" className="connection-intro"><PlugZap size={19} />先确认连接，再评估接入条件</h3>
      <p className="connection-description">此处仅检查币安只读接口连通性。真实的挂单、撤单在启用实盘后执行。</p>
      {(loadError || commandError) && <div className="inline-note connection-error" role="alert"><CircleAlert size={16} /><span>{commandError || loadError}{loadError && '；正在重试本地服务连接。'}</span></div>}
      {!connection ? <p className="connection-loading" role="status"><LoaderCircle size={15} className="spin" />正在读取服务端连接配置</p> : <>
        <div className="connection-config">
          <div><span>检查环境</span><strong>{connection.environment === 'demo' ? 'Binance Demo' : '币安正式环境'}<small>只读</small></strong><code>{connection.baseUrl}</code></div>
          <div><span><KeyRound size={13} />服务端凭据</span><strong className={connection.configurationIssue ? 'negative' : ''}>{connection.configurationIssue ? '配置需修正' : connection.credentialsConfigured ? '已配置 HMAC 凭据' : '尚未配置'}</strong><p>{connection.configurationIssue ?? (connection.credentialsConfigured ? '可勾选下方账户检查；不会展示 Key 或 Secret' : '无凭据也可检查公开接口')}</p></div>
        </div>
        <details className="connection-help">
          <summary>如何配置只读 API</summary>
          <p>在项目根目录复制 <code>.env.example</code> 为 <code>.env.local</code>，填写下列配置后双击 <code>重启工作台.cmd</code>。重启会保存持仓与策略并暂停机器人。Demo 与正式环境使用各自的 HMAC Key / Secret。</p>
          <pre>BINANCE_READONLY_ENV=demo{'\n'}BINANCE_READONLY_API_KEY=你的只读Key{'\n'}BINANCE_READONLY_API_SECRET=对应的Secret</pre>
          <p>正式环境将 <code>demo</code> 改为 <code>production</code>。使用专用读取凭据，Secret 留在本机，不要粘贴到聊天中。填写后需在「启用实盘交易」面板输入确认口令才会切换实盘。</p>
        </details>
        <form className="connection-controls" onSubmit={event => { event.preventDefault(); void start(); }}>
          <label className="field connection-symbol"><span className="field-label">检查合约</span><input aria-label="API 检查合约" value={symbol} onChange={event => setSymbol(event.target.value.toUpperCase())} placeholder="BTCUSDT" maxLength={30} pattern="[A-Z0-9]{3,30}" required autoComplete="off" spellCheck={false} disabled={running || submitting} /></label>
          <label className="connection-account-option"><input type="checkbox" checked={includeAccount && connection.credentialsConfigured} onChange={event => setIncludeAccount(event.target.checked)} disabled={!connection.credentialsConfigured || running || submitting} /><span>同时读取账户余额、持仓与费率<small>{connection.credentialsConfigured ? '仅本次检查，不修改账户设置' : '配置服务端凭据后可用'}</small></span></label>
          <button className="button primary" type="submit" disabled={!validSymbol || running || submitting || remaining > 0 || !!loadError}>{running || submitting ? <LoaderCircle size={16} className="spin" /> : <PlugZap size={16} />}{running ? '正在检查' : submitting ? '正在启动' : remaining > 0 ? `${remaining} 秒后可重试` : '运行连接检查'}</button>
        </form>
        <p className="connection-hint"><Clock3 size={13} />每次检查至少间隔 30 秒；遇到接口限流会延长等待时间。</p>
      </>}
      {report && <div className="connection-report" aria-live="polite" aria-busy={running}>
        <div className="connection-report-heading"><h3>{report.symbol} · {running ? '检查进行中' : '本次检查结果'}</h3><time>{stamp(report.finishedAt ?? report.startedAt)}</time></div>
        <div className="connection-outcomes">
          <span className={report.publicDataVerified ? 'verified' : ''}>{report.publicDataVerified ? <Check size={14} /> : <CircleAlert size={14} />}公开数据{report.publicDataVerified ? '已验证' : '尚未验证'}</span>
          <span className={report.accountReadVerified ? 'verified' : ''}>{report.accountReadVerified ? <Check size={14} /> : <CircleAlert size={14} />}账户余额{report.accountReadVerified ? '可读取' : '尚未验证'}</span>
          <span>实盘执行未实现</span>
        </div>
        <ul className="connection-checks">{report.checks.map(check => <li key={check.id} className={`check-${check.status}`}><span className="connection-check-label">{check.label}</span><span className="connection-check-badge">{labels[check.status]}</span><p>{check.detail}</p></li>)}</ul>
        {running && <p className="connection-loading"><LoaderCircle size={14} className="spin" />正在等待接口响应，结果将自动更新</p>}
      </div>}
      {account && report && <div className="connection-account">
        <div className="connection-report-heading"><h3>{report.environment === 'demo' ? 'Demo 账户快照' : '真实账户快照'}</h3><span>仅本次查询 · 非实时余额</span></div>
        <p>此处显示币安接口的只读结果；启用实盘后账户余额与持仓以币安为准。</p>
        <div className="table-scroll"><table><thead><tr><th>资产</th><th>钱包余额</th><th>可用余额</th><th>未实现盈亏</th></tr></thead><tbody>{account.assets.length ? account.assets.map(asset => <tr key={asset.asset}><td>{asset.asset}</td><td>{asset.walletBalance}</td><td>{asset.availableBalance}</td><td>{asset.unrealizedProfit}</td></tr>) : <tr><td colSpan={4}>账户未返回 USDT / USDC 资产</td></tr>}</tbody></table></div>
        <div className="connection-account-modes"><span>持仓模式：{account.hedgeMode === undefined ? '未验证' : account.hedgeMode ? '双向' : '单向'}</span><span>保证金：{account.multiAssetsMargin === undefined ? '未验证' : account.multiAssetsMargin ? '多资产' : '单资产'}</span><span>{report.symbol} Maker：{account.makerFeeRate === undefined ? '未验证' : `${Number(account.makerFeeRate) * 10000} bps`}</span><span>Taker：{account.takerFeeRate === undefined ? '未验证' : `${Number(account.takerFeeRate) * 10000} bps`}</span></div>
        {account.positions === undefined ? <p>持仓尚未读取，请查看检查结果。</p> : !account.positions.length ? <p>本次查询没有非零持仓。</p> : <div className="table-scroll"><table><thead><tr><th>合约 / 方向</th><th>持仓数量</th><th>开仓价</th><th>标记价</th><th>接口强平价</th></tr></thead><tbody>{account.positions.map(position => <tr key={`${position.symbol}-${position.positionSide}`}><td>{position.symbol}<small>{positionSides[position.positionSide] ?? position.positionSide}</small></td><td>{position.quantity}</td><td>{position.entryPrice}</td><td>{position.markPrice}</td><td>{position.liquidationPrice}</td></tr>)}</tbody></table></div>}
      </div>}
    </div>
  </section>;
}
