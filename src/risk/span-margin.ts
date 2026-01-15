/**
 * SPAN Margin Calculator for NSE Options Paper Trading
 *
 * Approximates NSE SPAN + Exposure margin requirements.
 * This is a SIMPLIFIED model - real SPAN is much more complex.
 *
 * Key Concepts:
 * - SPAN (Standard Portfolio Analysis of Risk) calculates risk-based margin
 * - It considers 16 scenarios of price and volatility changes
 * - We approximate with simplified rules based on moneyness and IV
 */

import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;
import {
  LOT_SIZES,
  MARGIN_PERCENTAGES,
  MONEYNESS_THRESHOLDS,
  RISK,
} from '../core/constants.js';
import { toDecimal, ZERO, ONE } from '../utils/decimal.js';
import { isExpiryDay, getDaysToExpiry } from '../utils/date.js';
import type {
  Position,
  MarginCalculation,
  Underlying,
  InstrumentType,
} from '../core/types.js';

// ============================================================================
// MARGIN CALCULATION
// ============================================================================

/**
 * Calculate margin for a single option position
 */
export function calculateOptionMargin(
  underlying: Underlying,
  instrumentType: 'CE' | 'PE',
  strike: number,
  side: 'LONG' | 'SHORT',
  quantity: number,
  avgPrice: Decimal,
  spotPrice: Decimal,
  currentIV: Decimal,
  expiry: Date
): MarginCalculation {
  const lotSize = LOT_SIZES[underlying];
  const lots = quantity / lotSize;

  // Long options: No margin (premium already paid)
  if (side === 'LONG') {
    const premiumPaid = avgPrice.times(quantity);
    return {
      spanMargin: ZERO,
      exposureMargin: ZERO,
      totalMargin: ZERO,
      premiumReceived: ZERO,
      premiumPaid,
      netMargin: ZERO,
    };
  }

  // SHORT OPTIONS - Calculate SPAN margin
  const spotNum = spotPrice.toNumber();
  const strikeNum = strike;
  const notional = spotPrice.times(lotSize).times(lots);

  // Calculate moneyness
  const moneyness = Math.abs(strikeNum - spotNum) / spotNum;

  // Determine base margin percentage based on moneyness
  let spanPct: Decimal;

  if (moneyness < MONEYNESS_THRESHOLDS.ATM) {
    // ATM: highest margin
    spanPct = new Decimal(MARGIN_PERCENTAGES.ATM_SHORT);
  } else if (moneyness < MONEYNESS_THRESHOLDS.NEAR_OTM) {
    // Slightly OTM
    spanPct = new Decimal(MARGIN_PERCENTAGES.NEAR_OTM_SHORT);
  } else if (moneyness < MONEYNESS_THRESHOLDS.OTM) {
    // OTM
    spanPct = new Decimal(MARGIN_PERCENTAGES.OTM_SHORT);
  } else {
    // Deep OTM
    spanPct = new Decimal(MARGIN_PERCENTAGES.DEEP_OTM_SHORT);
  }

  // IV adjustment: Higher IV = Higher margin
  // Baseline IV is 15%, add 0.5% margin for each IV point above
  const baselineIV = new Decimal(15);
  if (currentIV.greaterThan(baselineIV)) {
    const ivExcess = currentIV.minus(baselineIV);
    const ivAdjustment = ivExcess.times(0.005); // 0.5% per IV point
    spanPct = spanPct.plus(ivAdjustment);
  }

  // ITM adjustment: In-the-money options need intrinsic value buffer
  const isITM = instrumentType === 'CE'
    ? spotNum > strikeNum
    : strikeNum > spotNum;

  if (isITM) {
    const intrinsicValue = Math.abs(spotNum - strikeNum);
    const intrinsicPct = intrinsicValue / spotNum;
    spanPct = spanPct.plus(new Decimal(intrinsicPct * 0.5)); // 50% of ITM-ness
  }

  // Expiry day adjustment
  const daysToExpiry = getDaysToExpiry(expiry);
  if (daysToExpiry <= 0) {
    // Expiry day: Apply multiplier
    spanPct = spanPct.times(RISK.EXPIRY_DAY_MARGIN_MULTIPLIER);
  } else if (daysToExpiry <= 1) {
    // Day before: 25% extra
    spanPct = spanPct.times(1.25);
  } else if (daysToExpiry <= 3) {
    // Within 3 days: 10% extra
    spanPct = spanPct.times(1.10);
  }

  // Calculate SPAN margin
  const spanMargin = notional.times(spanPct);

  // Exposure margin: ~3% of notional
  const exposureMargin = notional.times(MARGIN_PERCENTAGES.EXPOSURE_MARGIN);

  // Total margin
  const totalMargin = spanMargin.plus(exposureMargin);

  // Premium received
  const premiumReceived = avgPrice.times(quantity);

  // Net margin = Total - Premium (but never negative)
  const netMargin = Decimal.max(ZERO, totalMargin.minus(premiumReceived));

  return {
    spanMargin,
    exposureMargin,
    totalMargin,
    premiumReceived,
    premiumPaid: ZERO,
    netMargin,
  };
}

/**
 * Calculate margin for futures position
 */
export function calculateFuturesMargin(
  underlying: Underlying,
  side: 'LONG' | 'SHORT',
  quantity: number,
  spotPrice: Decimal,
  expiry: Date
): MarginCalculation {
  const lotSize = LOT_SIZES[underlying];
  const lots = quantity / lotSize;
  const notional = spotPrice.times(lotSize).times(lots);

  // Initial margin: ~12% of notional
  const spanMargin = notional.times(MARGIN_PERCENTAGES.FUTURES_INITIAL);

  // Exposure margin: ~3% of notional
  const exposureMargin = notional.times(MARGIN_PERCENTAGES.FUTURES_EXPOSURE);

  // Expiry adjustment
  const daysToExpiry = getDaysToExpiry(expiry);
  let multiplier = ONE;
  if (daysToExpiry <= 3) {
    multiplier = new Decimal(1.1);
  }

  const adjustedSpan = spanMargin.times(multiplier);
  const adjustedExposure = exposureMargin.times(multiplier);

  return {
    spanMargin: adjustedSpan,
    exposureMargin: adjustedExposure,
    totalMargin: adjustedSpan.plus(adjustedExposure),
    premiumReceived: ZERO,
    premiumPaid: ZERO,
    netMargin: adjustedSpan.plus(adjustedExposure),
  };
}

// ============================================================================
// SPREAD MARGIN BENEFIT
// ============================================================================

/**
 * Identify if positions form a spread and calculate reduced margin
 *
 * Spread types:
 * - Vertical spread (same expiry, different strikes)
 * - Calendar spread (same strike, different expiries)
 * - Straddle/Strangle
 */
export interface SpreadAnalysis {
  isSpread: boolean;
  spreadType: 'VERTICAL' | 'CALENDAR' | 'STRADDLE' | 'STRANGLE' | 'IRON_CONDOR' | 'IRON_FLY' | 'NONE';
  maxLoss: Decimal;
  marginBenefit: Decimal;
  positions: Position[];
}

export function analyzeSpread(positions: Position[]): SpreadAnalysis {
  // Filter to same underlying and unexpired
  const underlyingGroups = new Map<Underlying, Position[]>();

  for (const pos of positions) {
    if (!pos.quantity) continue;

    const existing = underlyingGroups.get(pos.underlying) ?? [];
    existing.push(pos);
    underlyingGroups.set(pos.underlying, existing);
  }

  // Analyze each underlying
  for (const [underlying, positionsForUnderlying] of underlyingGroups) {
    const result = analyzeUnderlyingSpread(positionsForUnderlying);
    if (result.isSpread) {
      return result;
    }
  }

  return {
    isSpread: false,
    spreadType: 'NONE',
    maxLoss: ZERO,
    marginBenefit: ZERO,
    positions: [],
  };
}

function analyzeUnderlyingSpread(positions: Position[]): SpreadAnalysis {
  // Group by expiry
  const expiryGroups = new Map<string, Position[]>();
  for (const pos of positions) {
    const key = pos.expiry.toISOString();
    const existing = expiryGroups.get(key) ?? [];
    existing.push(pos);
    expiryGroups.set(key, existing);
  }

  // Check for vertical spreads (same expiry)
  for (const [, expiryPositions] of expiryGroups) {
    if (expiryPositions.length >= 2) {
      // Check for straddle (same strike, CE + PE short)
      const straddle = checkStraddle(expiryPositions);
      if (straddle.isSpread) return straddle;

      // Check for strangle (different strikes, CE + PE short)
      const strangle = checkStrangle(expiryPositions);
      if (strangle.isSpread) return strangle;

      // Check for iron condor/iron fly
      const iron = checkIronCondorOrFly(expiryPositions);
      if (iron.isSpread) return iron;

      // Check for vertical spread
      const vertical = checkVerticalSpread(expiryPositions);
      if (vertical.isSpread) return vertical;
    }
  }

  return {
    isSpread: false,
    spreadType: 'NONE',
    maxLoss: ZERO,
    marginBenefit: ZERO,
    positions: [],
  };
}

function checkStraddle(positions: Position[]): SpreadAnalysis {
  const shortCalls = positions.filter(p => p.instrumentType === 'CE' && p.side === 'SHORT');
  const shortPuts = positions.filter(p => p.instrumentType === 'PE' && p.side === 'SHORT');

  if (shortCalls.length === 1 && shortPuts.length === 1) {
    const call = shortCalls[0]!;
    const put = shortPuts[0]!;

    if (call.strike === put.strike && call.quantity === put.quantity) {
      // Straddle: Max loss is unlimited, but margin = single leg + premium
      const premiumReceived = call.avgPrice.plus(put.avgPrice).times(call.quantity);

      return {
        isSpread: true,
        spreadType: 'STRADDLE',
        maxLoss: new Decimal(Infinity),  // Unlimited
        marginBenefit: new Decimal(0.15), // 15% benefit (approximate)
        positions: [call, put],
      };
    }
  }

  return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
}

function checkStrangle(positions: Position[]): SpreadAnalysis {
  const shortCalls = positions.filter(p => p.instrumentType === 'CE' && p.side === 'SHORT');
  const shortPuts = positions.filter(p => p.instrumentType === 'PE' && p.side === 'SHORT');

  if (shortCalls.length === 1 && shortPuts.length === 1) {
    const call = shortCalls[0]!;
    const put = shortPuts[0]!;

    if (call.strike !== put.strike && call.quantity === put.quantity) {
      return {
        isSpread: true,
        spreadType: 'STRANGLE',
        maxLoss: new Decimal(Infinity),
        marginBenefit: new Decimal(0.15),
        positions: [call, put],
      };
    }
  }

  return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
}

function checkIronCondorOrFly(positions: Position[]): SpreadAnalysis {
  // Iron condor: Short CE + Long CE (higher) + Short PE + Long PE (lower)
  // Iron fly: Same as condor but short strikes are same (ATM)

  const calls = positions.filter(p => p.instrumentType === 'CE');
  const puts = positions.filter(p => p.instrumentType === 'PE');

  if (calls.length !== 2 || puts.length !== 2) {
    return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
  }

  const shortCall = calls.find(c => c.side === 'SHORT');
  const longCall = calls.find(c => c.side === 'LONG');
  const shortPut = puts.find(p => p.side === 'SHORT');
  const longPut = puts.find(p => p.side === 'LONG');

  if (!shortCall || !longCall || !shortPut || !longPut) {
    return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
  }

  // Verify structure
  if (
    longCall.strike! > shortCall.strike! &&  // Long call is higher strike
    longPut.strike! < shortPut.strike!       // Long put is lower strike
  ) {
    const isIronFly = shortCall.strike === shortPut.strike;

    // Max loss = Width of wider wing - net premium
    const callWidth = longCall.strike! - shortCall.strike!;
    const putWidth = shortPut.strike! - longPut.strike!;
    const maxWidth = Math.max(callWidth, putWidth);

    const netPremium = shortCall.avgPrice
      .plus(shortPut.avgPrice)
      .minus(longCall.avgPrice)
      .minus(longPut.avgPrice)
      .times(shortCall.quantity);

    const maxLoss = new Decimal(maxWidth).times(shortCall.quantity).minus(netPremium);

    return {
      isSpread: true,
      spreadType: isIronFly ? 'IRON_FLY' : 'IRON_CONDOR',
      maxLoss: Decimal.max(ZERO, maxLoss),
      marginBenefit: new Decimal(MARGIN_PERCENTAGES.SPREAD_BENEFIT),
      positions: [shortCall, longCall, shortPut, longPut],
    };
  }

  return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
}

function checkVerticalSpread(positions: Position[]): SpreadAnalysis {
  // Group by option type
  const calls = positions.filter(p => p.instrumentType === 'CE');
  const puts = positions.filter(p => p.instrumentType === 'PE');

  // Check call spread
  if (calls.length === 2) {
    const result = analyzeVerticalPair(calls);
    if (result.isSpread) return result;
  }

  // Check put spread
  if (puts.length === 2) {
    const result = analyzeVerticalPair(puts);
    if (result.isSpread) return result;
  }

  return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
}

function analyzeVerticalPair(positions: Position[]): SpreadAnalysis {
  if (positions.length !== 2) {
    return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
  }

  const [p1, p2] = positions;
  if (!p1 || !p2) {
    return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
  }

  // Must have opposite sides
  if (p1.side === p2.side) {
    return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
  }

  // Must have same quantity
  if (p1.quantity !== p2.quantity) {
    return { isSpread: false, spreadType: 'NONE', maxLoss: ZERO, marginBenefit: ZERO, positions: [] };
  }

  const short = p1.side === 'SHORT' ? p1 : p2;
  const long = p1.side === 'LONG' ? p1 : p2;

  // Calculate max loss
  const width = Math.abs(short.strike! - long.strike!);
  const netPremium = short.avgPrice.minus(long.avgPrice).times(short.quantity);

  // For credit spread: max loss = width - premium
  // For debit spread: max loss = premium paid
  const isCredit = short.avgPrice.greaterThan(long.avgPrice);
  const maxLoss = isCredit
    ? new Decimal(width).times(short.quantity).minus(netPremium)
    : netPremium.negated();

  return {
    isSpread: true,
    spreadType: 'VERTICAL',
    maxLoss: Decimal.max(ZERO, maxLoss),
    marginBenefit: new Decimal(MARGIN_PERCENTAGES.SPREAD_BENEFIT),
    positions: [short, long],
  };
}

// ============================================================================
// PORTFOLIO MARGIN
// ============================================================================

/**
 * Calculate total portfolio margin with spread benefits
 */
export function calculatePortfolioMargin(
  positions: Position[],
  spotPrices: Map<Underlying, Decimal>,
  ivs: Map<number, Decimal>  // token -> IV
): {
  totalMargin: Decimal;
  marginByPosition: Map<string, MarginCalculation>;
  spreadBenefit: Decimal;
  spreadsIdentified: SpreadAnalysis[];
} {
  const marginByPosition = new Map<string, MarginCalculation>();
  let rawTotalMargin = ZERO;

  // Calculate individual position margins
  for (const pos of positions) {
    if (!pos.quantity || pos.quantity === 0) continue;

    const spotPrice = spotPrices.get(pos.underlying) ?? ZERO;
    const iv = ivs.get(pos.instrumentToken) ?? new Decimal(20);

    let margin: MarginCalculation;

    if (pos.instrumentType === 'CE' || pos.instrumentType === 'PE') {
      margin = calculateOptionMargin(
        pos.underlying,
        pos.instrumentType,
        pos.strike!,
        pos.side,
        pos.quantity,
        pos.avgPrice,
        spotPrice,
        iv,
        pos.expiry
      );
    } else if (pos.instrumentType === 'FUT') {
      margin = calculateFuturesMargin(
        pos.underlying,
        pos.side,
        pos.quantity,
        spotPrice,
        pos.expiry
      );
    } else {
      continue;
    }

    marginByPosition.set(pos.id, margin);
    rawTotalMargin = rawTotalMargin.plus(margin.netMargin);
  }

  // Identify spreads for benefit
  const spreadAnalysis = analyzeSpread(positions);
  const spreadsIdentified: SpreadAnalysis[] = [];
  let spreadBenefit = ZERO;

  if (spreadAnalysis.isSpread) {
    spreadsIdentified.push(spreadAnalysis);

    // Calculate benefit
    const spreadPositionIds = new Set(spreadAnalysis.positions.map(p => p.id));
    let spreadMargin = ZERO;

    for (const pos of spreadAnalysis.positions) {
      const margin = marginByPosition.get(pos.id);
      if (margin) {
        spreadMargin = spreadMargin.plus(margin.netMargin);
      }
    }

    // For defined-risk spreads, margin = max loss * buffer
    if (spreadAnalysis.maxLoss.isFinite() && spreadAnalysis.maxLoss.greaterThan(0)) {
      const spreadRequiredMargin = spreadAnalysis.maxLoss.times(1.1); // 10% buffer
      const originalMargin = spreadMargin;
      const benefit = originalMargin.minus(spreadRequiredMargin);

      if (benefit.greaterThan(0)) {
        spreadBenefit = benefit;
        rawTotalMargin = rawTotalMargin.minus(spreadBenefit);
      }
    }
  }

  return {
    totalMargin: Decimal.max(ZERO, rawTotalMargin),
    marginByPosition,
    spreadBenefit,
    spreadsIdentified,
  };
}
