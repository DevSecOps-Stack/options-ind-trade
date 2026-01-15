/**
 * Slippage Calculator for NSE Options Paper Trading
 *
 * Implements realistic slippage model based on:
 * - Bid-ask spread
 * - Spot velocity
 * - IV level
 * - Order size vs liquidity
 * - Order book depth
 */

import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;
import { SLIPPAGE, LOT_SIZES } from '../core/constants.js';
import { toDecimal, ZERO, ONE, roundToTick } from '../utils/decimal.js';
import type {
  SlippageParams,
  SlippageResult,
  OrderBookDepth,
  Underlying,
} from '../core/types.js';

// ============================================================================
// SLIPPAGE CALCULATION
// ============================================================================

/**
 * Calculate total slippage for an order
 *
 * Slippage components:
 * 1. Base: Fixed minimum slippage (0.05)
 * 2. Spread: Portion of bid-ask spread
 * 3. Velocity: Spot movement speed impact
 * 4. IV: High IV = wider spreads
 * 5. Size: Large orders get worse fills
 * 6. Depth: Eating into order book
 */
export function calculateSlippage(params: SlippageParams): SlippageResult {
  const {
    orderSide,
    quantity,
    currentBid,
    currentAsk,
    spotVelocity,
    currentIV,
    avgDailyVolume,
    depth,
    underlying,
    instrumentType,
    daysToExpiry,
  } = params;

  const components = {
    base: ZERO,
    spread: ZERO,
    velocity: ZERO,
    iv: ZERO,
    size: ZERO,
    depth: ZERO,
  };

  // 1. BASE SLIPPAGE (always applied)
  components.base = SLIPPAGE.BASE_SLIPPAGE;

  // 2. SPREAD SLIPPAGE
  // If spread is wide (> 2% of mid), add proportional slippage
  const spread = currentAsk.minus(currentBid);
  const midPrice = currentBid.plus(currentAsk).dividedBy(2);

  if (midPrice.greaterThan(0)) {
    const spreadPct = spread.dividedBy(midPrice);
    if (spreadPct.greaterThan(SLIPPAGE.WIDE_SPREAD_THRESHOLD)) {
      // Add 10-20% of the spread as extra slippage
      components.spread = spread.times(0.15);
    }
  }

  // 3. VELOCITY SLIPPAGE
  // Fast moves = more slippage (market makers widen quotes)
  const absVelocity = spotVelocity.abs();

  if (absVelocity.greaterThan(SLIPPAGE.VELOCITY_LOW)) {
    // Scale: ~0.50 per 100 pts/sec velocity
    const velocitySlippage = absVelocity
      .dividedBy(100)
      .times(0.50);

    // Extra penalty for extreme velocity
    if (absVelocity.greaterThan(SLIPPAGE.VELOCITY_EXTREME)) {
      components.velocity = velocitySlippage.times(2);
    } else if (absVelocity.greaterThan(SLIPPAGE.VELOCITY_HIGH)) {
      components.velocity = velocitySlippage.times(1.5);
    } else {
      components.velocity = velocitySlippage;
    }
  }

  // 4. IV SLIPPAGE
  // High IV = market stress = wider spreads
  if (currentIV.greaterThan(SLIPPAGE.HIGH_IV_THRESHOLD)) {
    const ivExcess = currentIV.minus(SLIPPAGE.HIGH_IV_THRESHOLD);
    // ~0.02 per IV point above 25
    components.iv = ivExcess.times(SLIPPAGE.IV_MULTIPLIER);
  }

  // 5. SIZE SLIPPAGE
  // Large orders relative to average volume get worse fills
  if (avgDailyVolume > 0) {
    const avgTickVolume = avgDailyVolume / 300; // ~300 minutes trading
    const sizeRatio = quantity / avgTickVolume;

    if (sizeRatio > 1) {
      // Above average size
      const sizeSlippage = new Decimal(sizeRatio - 1)
        .times(SLIPPAGE.SIZE_MULTIPLIER)
        .times(midPrice.greaterThan(0) ? midPrice.times(0.001) : new Decimal(0.10));

      // Cap size slippage at 2% of price
      components.size = Decimal.min(sizeSlippage, midPrice.times(0.02));
    }
  }

  // 6. DEPTH SLIPPAGE
  // If order eats into the book, price impact increases
  if (depth) {
    const liquidity = orderSide === 'BUY'
      ? sumDepthQuantity(depth.sell, 3)  // Available on ask side
      : sumDepthQuantity(depth.buy, 3);   // Available on bid side

    if (liquidity > 0 && quantity > liquidity * 0.5) {
      // Order is > 50% of visible liquidity
      const depthImpact = new Decimal(quantity / liquidity - 0.5)
        .times(SLIPPAGE.DEPTH_MULTIPLIER)
        .times(spread);

      components.depth = depthImpact;
    }
  }

  // EXPIRY DAY PENALTY
  // Gamma risk makes market makers extra cautious
  if (instrumentType === 'CE' || instrumentType === 'PE') {
    if (daysToExpiry <= 0) {
      // Expiry day: double all slippage components
      Object.keys(components).forEach(key => {
        components[key as keyof typeof components] =
          components[key as keyof typeof components].times(2);
      });
    } else if (daysToExpiry <= 1) {
      // Day before expiry: 50% extra
      Object.keys(components).forEach(key => {
        components[key as keyof typeof components] =
          components[key as keyof typeof components].times(1.5);
      });
    }
  }

  // Calculate total
  const totalSlippage = components.base
    .plus(components.spread)
    .plus(components.velocity)
    .plus(components.iv)
    .plus(components.size)
    .plus(components.depth);

  // Round to tick size
  return {
    totalSlippage: roundToTick(totalSlippage),
    components,
  };
}

/**
 * Sum quantity across depth levels
 */
function sumDepthQuantity(
  levels: OrderBookDepth['buy'] | OrderBookDepth['sell'],
  count: number
): number {
  let total = 0;
  for (let i = 0; i < Math.min(count, levels.length); i++) {
    total += levels[i]?.quantity ?? 0;
  }
  return total;
}

// ============================================================================
// FILL PRICE CALCULATION
// ============================================================================

/**
 * Calculate fill price for an order
 *
 * BUY orders: fill at ask + slippage
 * SELL orders: fill at bid - slippage
 */
export function calculateFillPrice(
  orderSide: 'BUY' | 'SELL',
  currentBid: Decimal,
  currentAsk: Decimal,
  slippage: Decimal
): Decimal {
  if (orderSide === 'BUY') {
    // Buying: pay ask + slippage
    const fillPrice = currentAsk.plus(slippage);
    return roundToTick(fillPrice);
  } else {
    // Selling: receive bid - slippage
    const fillPrice = currentBid.minus(slippage);
    // Don't go below zero
    return roundToTick(Decimal.max(ZERO, fillPrice));
  }
}

/**
 * Calculate impact on order book (for large orders)
 * Returns array of fills at different price levels
 */
export interface DepthFill {
  price: Decimal;
  quantity: number;
  level: number;
}

export function calculateDepthFills(
  orderSide: 'BUY' | 'SELL',
  quantity: number,
  depth: OrderBookDepth,
  slippage: Decimal
): DepthFill[] {
  const fills: DepthFill[] = [];
  let remainingQty = quantity;

  const levels = orderSide === 'BUY' ? depth.sell : depth.buy;

  for (let i = 0; i < levels.length && remainingQty > 0; i++) {
    const level = levels[i];
    if (!level) continue;

    const fillQty = Math.min(remainingQty, level.quantity);
    let fillPrice = level.price;

    // Add slippage to first level only (for simplicity)
    if (i === 0) {
      fillPrice = orderSide === 'BUY'
        ? fillPrice.plus(slippage)
        : fillPrice.minus(slippage);
    }

    fills.push({
      price: roundToTick(fillPrice),
      quantity: fillQty,
      level: i,
    });

    remainingQty -= fillQty;
  }

  // If we couldn't fill everything from visible depth,
  // assume rest fills at worst visible price + penalty
  if (remainingQty > 0 && levels.length > 0) {
    const worstLevel = levels[levels.length - 1]!;
    const penaltyPrice = orderSide === 'BUY'
      ? worstLevel.price.times(1.005)  // 0.5% worse
      : worstLevel.price.times(0.995);

    fills.push({
      price: roundToTick(penaltyPrice),
      quantity: remainingQty,
      level: levels.length,
    });
  }

  return fills;
}

/**
 * Calculate weighted average fill price from depth fills
 */
export function calculateAverageFillPrice(fills: DepthFill[]): Decimal {
  if (fills.length === 0) return ZERO;

  let totalValue = ZERO;
  let totalQty = 0;

  for (const fill of fills) {
    totalValue = totalValue.plus(fill.price.times(fill.quantity));
    totalQty += fill.quantity;
  }

  if (totalQty === 0) return ZERO;
  return roundToTick(totalValue.dividedBy(totalQty));
}

// ============================================================================
// SLIPPAGE ESTIMATION
// ============================================================================

/**
 * Estimate slippage before placing order (for UI display)
 */
export function estimateSlippage(
  underlying: Underlying,
  instrumentType: 'CE' | 'PE' | 'FUT',
  quantity: number,
  currentSpread: Decimal,
  currentIV: Decimal,
  spotVelocity: Decimal
): {
  estimated: Decimal;
  range: { min: Decimal; max: Decimal };
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
} {
  // Quick estimate without full calculation
  let estimated = SLIPPAGE.BASE_SLIPPAGE;

  // Add spread component
  if (currentSpread.greaterThan(0.10)) {
    estimated = estimated.plus(currentSpread.times(0.15));
  }

  // Add velocity component
  const absVelocity = spotVelocity.abs();
  if (absVelocity.greaterThan(SLIPPAGE.VELOCITY_MEDIUM)) {
    estimated = estimated.plus(absVelocity.dividedBy(100).times(0.30));
  }

  // Add IV component
  if (currentIV.greaterThan(30)) {
    estimated = estimated.plus(currentIV.minus(30).times(0.02));
  }

  // Calculate range
  const min = estimated.times(0.5);
  const max = estimated.times(2.5);

  // Confidence based on velocity
  let confidence: 'LOW' | 'MEDIUM' | 'HIGH' = 'HIGH';
  if (absVelocity.greaterThan(SLIPPAGE.VELOCITY_HIGH)) {
    confidence = 'LOW';
  } else if (absVelocity.greaterThan(SLIPPAGE.VELOCITY_MEDIUM)) {
    confidence = 'MEDIUM';
  }

  return {
    estimated: roundToTick(estimated),
    range: {
      min: roundToTick(min),
      max: roundToTick(max),
    },
    confidence,
  };
}

// ============================================================================
// SLIPPAGE ANALYTICS
// ============================================================================

/**
 * Track slippage over time for analysis
 */
export interface SlippageRecord {
  timestamp: Date;
  symbol: string;
  side: 'BUY' | 'SELL';
  expectedSlippage: Decimal;
  actualSlippage: Decimal;
  components: SlippageResult['components'];
  spotVelocity: Decimal;
  iv: Decimal;
  quantity: number;
}

export class SlippageAnalyzer {
  private records: SlippageRecord[] = [];
  private maxRecords = 1000;

  addRecord(record: SlippageRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  getAverageSlippage(): Decimal {
    if (this.records.length === 0) return ZERO;

    const total = this.records.reduce(
      (sum, r) => sum.plus(r.actualSlippage),
      ZERO
    );
    return total.dividedBy(this.records.length);
  }

  getSlippageByVelocity(): Map<string, Decimal> {
    const buckets = new Map<string, { total: Decimal; count: number }>();

    for (const record of this.records) {
      const velocity = record.spotVelocity.abs();
      let bucket: string;

      if (velocity.lessThan(SLIPPAGE.VELOCITY_LOW)) {
        bucket = 'LOW';
      } else if (velocity.lessThan(SLIPPAGE.VELOCITY_MEDIUM)) {
        bucket = 'MEDIUM';
      } else if (velocity.lessThan(SLIPPAGE.VELOCITY_HIGH)) {
        bucket = 'HIGH';
      } else {
        bucket = 'EXTREME';
      }

      const existing = buckets.get(bucket) ?? { total: ZERO, count: 0 };
      buckets.set(bucket, {
        total: existing.total.plus(record.actualSlippage),
        count: existing.count + 1,
      });
    }

    const averages = new Map<string, Decimal>();
    for (const [bucket, { total, count }] of buckets) {
      averages.set(bucket, total.dividedBy(count));
    }

    return averages;
  }

  getSlippageAccuracy(): Decimal {
    if (this.records.length === 0) return ZERO;

    let totalError = ZERO;
    for (const record of this.records) {
      const error = record.actualSlippage
        .minus(record.expectedSlippage)
        .abs()
        .dividedBy(record.expectedSlippage.isZero() ? ONE : record.expectedSlippage);
      totalError = totalError.plus(error);
    }

    return ONE.minus(totalError.dividedBy(this.records.length));
  }

  clear(): void {
    this.records = [];
  }
}

// Singleton analyzer
const slippageAnalyzer = new SlippageAnalyzer();
export { slippageAnalyzer };
