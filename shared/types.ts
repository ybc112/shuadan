export type QuoteAsset = 'USDT' | 'USDC';
export type MarketSource = 'simulation' | 'binance';
export type SizingMode = 'quote' | 'base' | 'contracts' | 'equity_pct' | 'available_pct';
export type RobotStatus = 'paused' | 'running' | 'cooldown' | 'reduce_only';
export type Side = 'BUY' | 'SELL';
export type ExecutionMode = 'paper' | 'live';
export type ExecutionStatus = 'idle' | 'switching' | 'live' | 'syncing' | 'error' | 'disconnected';
export type FillExecution = 'SIMULATED' | 'LIVE';

export interface Instrument {
  symbol: string;
  baseAsset: string;
  quoteAsset: QuoteAsset;
  priceTick: string;
  quantityStep: string;
  minQty: string;
  maxQty: string;
  minNotional: string;
}

export interface Market extends Instrument {
  bid: string;
  ask: string;
  bidQty: string;
  askQty: string;
  markPrice: string;
  changePercent: number;
  quoteVolume: number;
  updatedAt: number;
  history: { time: number; price: number }[];
}

export interface RobotConfig {
  name: string;
  symbol: string;
  sizingMode: SizingMode;
  orderSize: number;
  contractSize: number;
  gridCount: number;
  rangeMode: 'fixed' | 'bps';
  halfRange: number;
  recenterMinutes: number;
  repriceSeconds: number;
  orderTtlSeconds: number;
  closeOffsetMode: 'fixed' | 'bps';
  closeLongOffset: number;
  closeShortOffset: number;
  leverage: number;
  maxPositionNotional: number;
  maxOpenNotional: number;
  maxOrderNotional: number;
  stopLossQuote: number;
  /** 止损的按仓位比例阈值（占持仓名义额百分比），与 stopLossQuote 取小值生效 */
  stopLossPercent: number;
  shockPercent: number;
  cooldownSeconds: number;
  makerFeeBps: number;
  /** 库存偏斜系数：0=关闭；持仓越偏离零，中心价越往减仓方向偏（1 = 满仓时偏移整段单边半区间） */
  inventorySkew: number;
  /** 只减仓超时秒数：超过该时长仍未平掉就跨价成交；0 = 关闭，保持纯 Maker 语义 */
  exitTimeoutSeconds: number;
}

export interface Robot extends RobotConfig {
  id: string;
  createdAt: number;
  status: RobotStatus;
  reason: string;
  cooldownUntil: number;
  centerPrice: string;
  lastRecenterAt: number;
  lastQuoteAt: number;
  positionQty: string;
  entryPrice: string;
  realizedPnl: string;
  fees: string;
  filledNotional: string;
  fillCount: number;
  // Live-mode identifiers. Only populated when a real order is placed.
  liveOrderId?: string;
  liveClientOrderId?: string;
  lastSyncedAt?: number;
}

export interface Order {
  id: string;
  robotId: string;
  symbol: string;
  side: Side;
  price: string;
  quantity: string;
  remaining: string;
  reduceOnly: boolean;
  createdAt: number;
  timeInForce: 'GTX' | 'GTC';
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED';
  // Live-mode: the orderId returned by the exchange for this resting order.
  liveOrderId?: string;
  liveClientOrderId?: string;
  lastSyncedAt?: number;
}

export interface Fill {
  id: string;
  orderId: string;
  robotId: string;
  symbol: string;
  side: Side;
  price: string;
  quantity: string;
  fee: string;
  realizedPnl: string;
  time: number;
  liquidity: 'MAKER' | 'TAKER';
  execution: FillExecution;
  tradeId?: string;
}

export interface AuditEvent {
  id: string;
  time: number;
  level: 'info' | 'warning' | 'critical';
  category: 'system' | 'order' | 'risk' | 'robot' | 'live' | 'ai';
  message: string;
  robotId?: string;
  symbol?: string;
}

export interface RiskSettings {
  maxGrossNotional: number;
  maxMarginPercent: number;
  dailyLossLimit: number;
  maxDrawdownPercent: number;
  staleAfterSeconds: number;
  maxActionsPerMinute: number;
  /** 全局熔断后是否自动平仓；false = 保留持仓交人工复核（原设计） */
  flattenOnStop: boolean;
}

export interface QuoteAccount {
  asset: QuoteAsset;
  wallet: string;
  equity: string;
  unrealizedPnl: string;
  usedMargin: string;
  available: string;
}

export interface LiveAccountAsset {
  asset: string;
  walletBalance: string;
  availableBalance: string;
  unrealizedProfit: string;
  marginBalance: string;
}

export interface LiveAccount {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  totalPositionInitialMargin: string;
  totalOpenOrderInitialMargin: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  assets: LiveAccountAsset[];
  fetchedAt: number;
}

export interface LiveStatus {
  environment: 'demo' | 'production';
  baseUrl: string;
  configured: boolean;
  configurationIssue: string | null;
  blockedUntil: number;
  lastWeight: number;
  ordersThisMinute: number;
  lastSyncedAt: number | null;
  lastAccountSyncAt: number | null;
  lastAccountError: string | null;
}

export interface Summary {
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
  filledNotional: number;
  grossPosition: number;
  reservedNotional: number;
  usedMargin: number;
  dailyPnl: number;
  drawdownPercent: number;
  runningCount: number;
  ordersCount: number;
  actionsLastMinute: number;
  accounts: QuoteAccount[];
}

export interface AppState {
  version: 1;
  now: number;
  execution: ExecutionMode;
  executionStatus: ExecutionStatus;
  executionMessage: string;
  source: MarketSource;
  feed: { status: 'connected' | 'connecting' | 'stale' | 'error'; message: string; updatedAt: number };
  markets: Market[];
  robots: Robot[];
  orders: Order[];
  fills: Fill[];
  events: AuditEvent[];
  settings: RiskSettings;
  emergencyStopped: boolean;
  stopReason: string;
  summary: Summary;
  liveAccount: LiveAccount | null;
  liveStatus: LiveStatus | null;
  sessionToken?: string;
}

export const STATUS_LABELS: Record<RobotStatus, string> = {
  paused: '已暂停', running: '运行中', cooldown: '风控熔断', reduce_only: '只减仓',
};

export const SIZING_LABELS: Record<SizingMode, string> = {
  quote: '固定 U 金额', base: '固定币数量', contracts: '自定义张数',
  equity_pct: '账户权益 %', available_pct: '可用余额 %',
};
