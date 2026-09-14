import Decimal from 'decimal.js';
import type { Instrument, Market, Order, QuoteAccount, Robot, RobotConfig, Side } from '../shared/types';

export const D = (value: Decimal.Value) => new Decimal(value);
export const floorStep = (value: Decimal.Value, step: Decimal.Value) => D(value).div(step).floor().mul(step);
export const ceilStep = (value: Decimal.Value, step: Decimal.Value) => D(value).div(step).ceil().mul(step);

export function midPrice(market: Market): Decimal {
  return D(market.bid).plus(market.ask).div(2);
}

export function validMarket(market: Market): boolean {
  try {
    return [market.bid, market.ask, market.markPrice, market.priceTick, market.quantityStep]
      .every(n => D(n).isFinite() && D(n).gt(0)) && D(market.bid).lt(market.ask)
      && [market.bidQty, market.askQty].every(n => D(n).isFinite() && D(n).gte(0))
      && Number.isFinite(market.updatedAt);
  } catch { return false; }
}

export function makerPrice(side: Side, target: Decimal.Value, market: Market): string {
  if (!validMarket(market)) throw new Error('盘口无效，禁止报价');
  const price = side === 'BUY'
    ? floorStep(Decimal.min(D(target), D(market.bid)), market.priceTick)
    : ceilStep(Decimal.max(D(target), D(market.ask)), market.priceTick);
  if (price.lte(0)) throw new Error('挂单价格必须大于零');
  return price.toFixed();
}

export function orderQuantity(config: RobotConfig, instrument: Instrument, price: string, account: QuoteAccount): string {
  let qty: Decimal;
  switch (config.sizingMode) {
    case 'base': qty = D(config.orderSize); break;
    case 'contracts': qty = D(config.orderSize).mul(config.contractSize); break;
    case 'equity_pct': qty = D(account.equity).mul(config.orderSize).div(100).div(price); break;
    case 'available_pct': qty = D(account.available).mul(config.orderSize).div(100).div(price); break;
    default: qty = D(config.orderSize).div(price);
  }
  const normalized = floorStep(qty, instrument.quantityStep);
  if (normalized.lt(instrument.minQty)) throw new Error(`单格数量不足，${instrument.symbol} 最少 ${instrument.minQty} ${instrument.baseAsset}`);
  if (normalized.gt(instrument.maxQty)) throw new Error('单格数量超过交易规则上限');
  const notional = normalized.mul(price);
  if (notional.lt(instrument.minNotional)) throw new Error(`单格金额不足，最小名义金额为 ${instrument.minNotional} ${instrument.quoteAsset}`);
  if (notional.gt(config.maxOrderNotional)) throw new Error('单格金额超过配置的单笔名义金额上限');
  return normalized.toFixed();
}

export function gridLevels(config: RobotConfig, market: Market, center = midPrice(market).toFixed()): { side: Side; price: string }[] {
  const mid = D(center);
  const half = config.rangeMode === 'fixed' ? D(config.halfRange) : mid.mul(config.halfRange).div(10000);
  if (half.gte(mid)) throw new Error('网格下界必须大于零');
  const count = config.gridCount / 2;
  const step = half.div(count);
  if (step.lt(market.priceTick)) throw new Error(`网格过密：每格差价不得小于 ${market.priceTick}`);
  const levels: { side: Side; price: string }[] = [];
  const seen = new Set<string>();
  for (let i = 1; i <= count; i++) {
    for (const side of ['BUY', 'SELL'] as const) {
      const target = side === 'BUY' ? mid.minus(step.mul(i)) : mid.plus(step.mul(i));
      const price = makerPrice(side, target, market);
      const key = `${side}:${price}`;
      if (!seen.has(key)) { levels.push({ side, price }); seen.add(key); }
    }
  }
  return levels;
}

export function unrealized(robot: Robot, market?: Market): Decimal {
  return market ? D(market.markPrice).minus(robot.entryPrice).mul(robot.positionQty) : D(0);
}

export function positionNotional(robot: Robot, market?: Market): Decimal {
  return D(robot.positionQty).abs().mul(market?.markPrice ?? robot.entryPrice);
}

export function openingNotional(orders: Order[], robotId?: string): Decimal {
  return orders.filter(o => !o.reduceOnly && (!robotId || o.robotId === robotId))
    .reduce((sum, o) => sum.plus(D(o.remaining).mul(o.price)), D(0));
}

// Worst case: all outstanding orders on one side fill before any hedge can fill.
export function worstPosition(robot: Robot, orders: Order[], side: Side, extraQty: string, price: string): Decimal {
  const sameSide = orders.filter(o => o.robotId === robot.id && o.side === side && !o.reduceOnly)
    .reduce((sum, o) => sum.plus(o.remaining), D(0)).plus(extraQty);
  const after = D(robot.positionQty).plus(side === 'BUY' ? sameSide : sameSide.neg());
  return Decimal.max(after.abs().mul(price), D(robot.positionQty).abs().mul(price));
}

export function positionAfterFill(position: string, entry: string, side: Side, qty: string, price: string) {
  const old = D(position), trade = D(qty).mul(side === 'BUY' ? 1 : -1), next = old.plus(trade);
  let realized = D(0), avg = D(entry);
  if (old.isZero() || old.isPositive() === trade.isPositive()) {
    avg = old.abs().mul(entry).plus(trade.abs().mul(price)).div(next.abs());
  } else {
    const closed = Decimal.min(old.abs(), trade.abs());
    realized = D(price).minus(entry).mul(closed).mul(old.isPositive() ? 1 : -1);
    if (next.isZero()) avg = D(0);
    else if (next.isPositive() !== old.isPositive()) avg = D(price);
  }
  return { positionQty: next.toFixed(), entryPrice: avg.toFixed(), realizedPnl: realized.toFixed() };
}
