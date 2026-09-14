export type BinanceEnvironment = 'demo' | 'production';
export type ConnectionCheckStatus = 'passed' | 'warning' | 'failed' | 'skipped' | 'not_implemented';

export interface ConnectionCheck {
  id: string;
  label: string;
  status: ConnectionCheckStatus;
  detail: string;
}

export interface ConnectionAccount {
  assets: { asset: string; walletBalance: string; availableBalance: string; unrealizedProfit: string }[];
  positions?: { symbol: string; positionSide: string; quantity: string; entryPrice: string; markPrice: string; liquidationPrice: string }[];
  hedgeMode?: boolean;
  multiAssetsMargin?: boolean;
  makerFeeRate?: string;
  takerFeeRate?: string;
}

export interface ConnectionReport {
  id: string;
  environment: BinanceEnvironment;
  symbol: string;
  startedAt: number;
  finishedAt: number | null;
  publicDataVerified: boolean;
  accountReadVerified: boolean;
  liveTradingAvailable: false;
  checks: ConnectionCheck[];
  clock?: { offsetMs: number; roundTripMs: number };
  account?: ConnectionAccount;
}

export interface ConnectionStatus {
  environment: BinanceEnvironment;
  baseUrl: string;
  credentialsConfigured: boolean;
  configurationIssue: string | null;
  running: boolean;
  nextCheckAt: number;
  lastReport: ConnectionReport | null;
  execution: 'read-only';
}
