// 超级趋势（Supertrend）指标——纯函数，无 IO，便于单元测试。
// 算法（TradingView Pine 标准实现）：
//   ATR = Wilder 平滑(3)
//   中价 = (high+low)/2，上轨 = 中价+乘数×ATR，下轨 = 中价-乘数×ATR
//   finalUpper = min(计算上轨, 前根 finalUpper)；finalLower = max(计算下轨, 前根 finalLower)
//   （即轨道永远只收不放）
//   翻转：收盘 > 前根 finalUpper → 空转多；收盘 < 前根 finalLower → 多转空
// 返回最后一根趋势方向：+1 上升（做多），-1 下降（做空）。

export type Candle = { high: number; low: number; close: number };

export interface SuperTrendResult {
  direction: 1 | -1;
  line: number;
  atr: number;
}

export function sma(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
}

export function trueRanges(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!prev) { out.push(c.high - c.low); continue; }
    out.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return out;
}

export function wilderSmooth(values: number[], window: number): number[] {
  const out: number[] = [];
  let seed = sma(values.slice(0, window));
  for (let i = 0; i < values.length; i++) {
    if (i < window - 1) { out.push(NaN); continue; }
    if (i === window - 1) { out.push(seed); continue; }
    seed = (seed * (window - 1) + values[i]) / window;
    out.push(seed);
  }
  return out;
}

export function supertrend(candles: Candle[], window = 3, multiplier = 1.5): SuperTrendResult | null {
  if (candles.length < Math.max(window + 2, 6)) return null;
  const trs = trueRanges(candles);
  const atrs = wilderSmooth(trs, window);
  const n = candles.length;
  const start = window - 1; // 第一根有效 atr 的索引（wilder 从 window-1 起），完整窗口参与翻转演化
  let direction: 1 | -1 = 1;
  let prevUpper = 0, prevLower = 0;
  let first = true;

  for (let i = start; i < n; i++) {
    const atr = atrs[i];
    if (!Number.isFinite(atr)) continue;
    const mid = (candles[i].high + candles[i].low) / 2;
    const close = candles[i].close;
    const upper = mid + multiplier * atr;
    const lower = mid - multiplier * atr;

    let finalUpper: number, finalLower: number;
    let flipChecked = false;
    if (first) {
      finalUpper = upper; finalLower = lower;
      first = false;
    } else {
      // 轨道只沿趋势方向收：上轨取小、下轨取大（永远不会反向张开）
      finalUpper = Math.min(upper, prevUpper);
      finalLower = Math.max(lower, prevLower);
      // 翻转判定（标准）：收盘突破上一根上轨 → 空转多；跌破上一根下轨 → 多转空
      flipChecked = true;
    }
    if (flipChecked) {
      if (close > prevUpper) direction = 1;
      else if (close < prevLower) direction = -1;
    }
    prevUpper = finalUpper; prevLower = finalLower;
  }
  const atr = atrs[n - 1];
  return { direction, line: direction === 1 ? prevLower : prevUpper, atr: Number.isFinite(atr) ? atr : 0 };
}