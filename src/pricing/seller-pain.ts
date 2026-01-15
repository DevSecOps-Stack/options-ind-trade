/**
 * Seller Pain Model for NSE Options Paper Trading
 *
 * Models the IV inflation and premium expansion that hurts option sellers
 * during fast spot moves. This is CRITICAL for realistic paper trading.
 */

import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;
import { PRICING, SLIPPAGE } from '../core/constants.js';
import { toDecimal, ZERO, ONE } from '../utils/decimal.js';
import { calculateOptionPrice, calculateGreeks, isITM, isATM } from './black-scholes.js';
import type { BSParams, Greeks, IVInflationParams, Underlying, SpotDirection } from '../core/types.js';

// ============================================================================
// IV INFLATION MODEL
// ============================================================================

/**
 * Calculate inflated IV during fast spot moves
 *
 * Key insight: When spot moves fast, market makers widen spreads and IV spikes.
 * This causes significant mark-to-market losses for option sellers.
 *
 * Formula: inflatedIV = baseIV * inflationFactor
 * inflationFactor depends on:
 * 1. Velocity of spot movement
 * 2. Acceleration (is it speeding up?)
 * 3. Direction relative to option type
 * 4. Moneyness (ATM options most affected)
 * 5. Time to expiry (near-expiry more affected)
 */
export function calculateInflatedIV(params: IVInflationParams): Decimal {
  const {
    baseIV,
    spotVelocity,
    spotAcceleration,
    timeToExpiry,
    moneyness,
    direction,
  } = params;

  // Start with base inflation
  let inflationFactor = new Decimal(PRICING.IV_INFLATION_BASE);

  // 1. Velocity-based inflation
  const absVelocity = spotVelocity.abs();

  if (absVelocity.greaterThanOrEqualTo(SLIPPAGE.VELOCITY_EXTREME)) {
    inflationFactor = new Decimal(PRICING.IV_INFLATION_EXTREME);
  } else if (absVelocity.greaterThanOrEqualTo(SLIPPAGE.VELOCITY_HIGH)) {
    inflationFactor = new Decimal(PRICING.IV_INFLATION_HIGH);
  } else if (absVelocity.greaterThanOrEqualTo(SLIPPAGE.VELOCITY_MEDIUM)) {
    inflationFactor = new Decimal(PRICING.IV_INFLATION_MEDIUM);
  }

  // 2. Acceleration boost (if move is speeding up, more pain)
  if (spotAcceleration.abs().greaterThan(2)) {
    inflationFactor = inflationFactor.times(1.1);
  }

  // 3. Moneyness adjustment
  // ATM options (moneyness close to 1) are most affected
  // Deep OTM/ITM options less affected
  const moneynessDistance = moneyness.minus(1).abs();
  if (moneynessDistance.lessThan(0.02)) {
    // ATM: full inflation
    // No adjustment
  } else if (moneynessDistance.lessThan(0.05)) {
    // Near ATM: 80% inflation
    inflationFactor = ONE.plus(inflationFactor.minus(1).times(0.8));
  } else if (moneynessDistance.lessThan(0.10)) {
    // OTM: 60% inflation
    inflationFactor = ONE.plus(inflationFactor.minus(1).times(0.6));
  } else {
    // Deep OTM: 40% inflation
    inflationFactor = ONE.plus(inflationFactor.minus(1).times(0.4));
  }

  // 4. Time to expiry adjustment
  // Near-expiry options (gamma risk) more affected
  if (timeToExpiry <= 1) {
    // Expiry day: maximum pain
    inflationFactor = inflationFactor.times(1.3);
  } else if (timeToExpiry <= 3) {
    // Within 3 days
    inflationFactor = inflationFactor.times(1.15);
  } else if (timeToExpiry <= 7) {
    // Within week
    inflationFactor = inflationFactor.times(1.05);
  }

  // Apply inflation
  return baseIV.times(inflationFactor);
}

/**
 * Calculate the "pain" a short option position experiences during a fast move
 */
export interface SellerPain {
  originalValue: Decimal;      // Value before move
  inflatedValue: Decimal;      // Value after IV inflation
  mtmLoss: Decimal;           // Mark-to-market loss
  ivChange: Decimal;          // IV increase
  greeksImpact: {
    deltaImpact: Decimal;     // Loss from delta
    gammaImpact: Decimal;     // Loss from gamma convexity
    vegaImpact: Decimal;      // Loss from IV increase
  };
}

export function calculateSellerPain(
  position: {
    quantity: number;
    avgPrice: Decimal;
    optionType: 'CE' | 'PE';
  },
  originalParams: BSParams,
  spotMovement: {
    newSpot: Decimal;
    velocity: Decimal;
    acceleration: Decimal;
    direction: SpotDirection;
  },
  timeDecay: Decimal  // Fraction of day passed
): SellerPain {
  const { quantity, avgPrice, optionType } = position;
  const originalGreeks = calculateGreeks(originalParams);

  // Calculate original position value
  const originalPrice = calculateOptionPrice(originalParams);
  const originalValue = originalPrice.times(quantity);

  // Calculate inflated IV
  const moneyness = spotMovement.newSpot.dividedBy(originalParams.strike);
  const daysToExpiry = originalParams.timeToExpiry.times(PRICING.DAYS_IN_YEAR).toNumber();

  const inflatedIV = calculateInflatedIV({
    baseIV: originalParams.volatility,
    spotVelocity: spotMovement.velocity,
    spotAcceleration: spotMovement.acceleration,
    timeToExpiry: daysToExpiry,
    moneyness,
    direction: spotMovement.direction,
  });

  // Calculate new price with inflated IV
  const newParams: BSParams = {
    ...originalParams,
    spot: spotMovement.newSpot,
    volatility: inflatedIV,
    // Adjust time for decay
    timeToExpiry: Decimal.max(
      PRICING.MIN_TIME_TO_EXPIRY,
      originalParams.timeToExpiry.minus(timeDecay.dividedBy(PRICING.DAYS_IN_YEAR))
    ),
  };

  const inflatedPrice = calculateOptionPrice(newParams);
  const inflatedValue = inflatedPrice.times(quantity);

  // For short positions, loss = new value - original value
  // (we're short, so if value goes up, we lose)
  const mtmLoss = inflatedValue.minus(originalValue);

  // Calculate Greeks impact breakdown
  const spotChange = spotMovement.newSpot.minus(originalParams.spot);

  // Delta impact: spotChange * delta * quantity
  const deltaImpact = spotChange.times(originalGreeks.delta).times(quantity);

  // Gamma impact: 0.5 * spotChange^2 * gamma * quantity
  const gammaImpact = spotChange.times(spotChange).times(0.5)
    .times(originalGreeks.gamma).times(quantity);

  // Vega impact: ivChange * vega * quantity
  const ivChange = inflatedIV.minus(originalParams.volatility).times(100); // In percentage points
  const vegaImpact = ivChange.times(originalGreeks.vega).times(quantity);

  return {
    originalValue,
    inflatedValue,
    mtmLoss,
    ivChange,
    greeksImpact: {
      deltaImpact,
      gammaImpact,
      vegaImpact,
    },
  };
}

// ============================================================================
// STRADDLE/STRANGLE PAIN CALCULATOR
// ============================================================================

export interface StrategyPain {
  totalMtmLoss: Decimal;
  legPains: Array<{
    optionType: 'CE' | 'PE';
    strike: number;
    mtmLoss: Decimal;
  }>;
  netDelta: Decimal;
  netGamma: Decimal;
  netVega: Decimal;
  worstCaseLoss: Decimal;
}

/**
 * Calculate pain for a multi-leg strategy (straddle, strangle, etc.)
 */
export function calculateStrategyPain(
  legs: Array<{
    optionType: 'CE' | 'PE';
    strike: number;
    quantity: number;
    avgPrice: Decimal;
    isShort: boolean;
  }>,
  originalSpot: Decimal,
  newSpot: Decimal,
  baseIV: Decimal,
  timeToExpiry: Decimal,
  riskFreeRate: Decimal,
  spotVelocity: Decimal
): StrategyPain {
  let totalMtmLoss = ZERO;
  const legPains: StrategyPain['legPains'] = [];
  let netDelta = ZERO;
  let netGamma = ZERO;
  let netVega = ZERO;

  for (const leg of legs) {
    const params: BSParams = {
      spot: originalSpot,
      strike: toDecimal(leg.strike),
      timeToExpiry,
      riskFreeRate,
      volatility: baseIV,
      optionType: leg.optionType,
    };

    const greeks = calculateGreeks(params);
    const originalPrice = calculateOptionPrice(params);

    // Calculate inflated IV for this strike
    const moneyness = newSpot.dividedBy(leg.strike);
    const daysToExpiry = timeToExpiry.times(PRICING.DAYS_IN_YEAR).toNumber();

    const direction: SpotDirection = newSpot.greaterThan(originalSpot) ? 'UP' : 'DOWN';
    const inflatedIV = calculateInflatedIV({
      baseIV,
      spotVelocity,
      spotAcceleration: ZERO,
      timeToExpiry: daysToExpiry,
      moneyness,
      direction,
    });

    const newParams: BSParams = {
      ...params,
      spot: newSpot,
      volatility: inflatedIV,
    };

    const newPrice = calculateOptionPrice(newParams);
    const priceDiff = newPrice.minus(originalPrice);

    // For short positions, loss is positive priceDiff
    // For long positions, loss is negative priceDiff
    const legLoss = leg.isShort
      ? priceDiff.times(leg.quantity)
      : priceDiff.times(leg.quantity).negated();

    totalMtmLoss = totalMtmLoss.plus(legLoss);
    legPains.push({
      optionType: leg.optionType,
      strike: leg.strike,
      mtmLoss: legLoss,
    });

    // Aggregate Greeks
    const sign = leg.isShort ? -1 : 1;
    netDelta = netDelta.plus(greeks.delta.times(leg.quantity * sign));
    netGamma = netGamma.plus(greeks.gamma.times(leg.quantity * sign));
    netVega = netVega.plus(greeks.vega.times(leg.quantity * sign));
  }

  // Calculate worst case loss (extreme move scenario)
  const worstCaseLoss = calculateWorstCaseLoss(legs, originalSpot, baseIV, timeToExpiry, riskFreeRate);

  return {
    totalMtmLoss,
    legPains,
    netDelta,
    netGamma,
    netVega,
    worstCaseLoss,
  };
}

/**
 * Calculate worst case loss for a strategy (5 sigma move)
 */
function calculateWorstCaseLoss(
  legs: Array<{
    optionType: 'CE' | 'PE';
    strike: number;
    quantity: number;
    avgPrice: Decimal;
    isShort: boolean;
  }>,
  spot: Decimal,
  baseIV: Decimal,
  timeToExpiry: Decimal,
  riskFreeRate: Decimal
): Decimal {
  // 5 sigma daily move
  const dailyVol = baseIV.dividedBy(Math.sqrt(252));
  const fiveSigmaMove = spot.times(dailyVol.times(5));

  // Calculate loss for extreme up and down moves
  const extremeUp = spot.plus(fiveSigmaMove);
  const extremeDown = spot.minus(fiveSigmaMove);

  let upLoss = ZERO;
  let downLoss = ZERO;

  for (const leg of legs) {
    const params: BSParams = {
      spot,
      strike: toDecimal(leg.strike),
      timeToExpiry,
      riskFreeRate,
      volatility: baseIV.times(2), // Double IV in extreme scenario
      optionType: leg.optionType,
    };

    const originalPrice = calculateOptionPrice(params);

    // Up scenario
    const upParams = { ...params, spot: extremeUp };
    const upPrice = calculateOptionPrice(upParams);
    const upDiff = upPrice.minus(originalPrice);
    upLoss = upLoss.plus(leg.isShort ? upDiff.times(leg.quantity) : upDiff.times(leg.quantity).negated());

    // Down scenario
    const downParams = { ...params, spot: extremeDown };
    const downPrice = calculateOptionPrice(downParams);
    const downDiff = downPrice.minus(originalPrice);
    downLoss = downLoss.plus(leg.isShort ? downDiff.times(leg.quantity) : downDiff.times(leg.quantity).negated());
  }

  return Decimal.max(upLoss, downLoss);
}

// ============================================================================
// EXPIRY DAY GAMMA PAIN
// ============================================================================

/**
 * Calculate gamma pain on expiry day
 * This is when short options can cause massive losses in minutes
 */
export function calculateExpiryGammaPain(
  strike: number,
  spot: Decimal,
  optionType: 'CE' | 'PE',
  quantity: number,
  minutesToExpiry: number
): {
  currentValue: Decimal;
  valueIf1PercentMove: Decimal;
  gammaPain: Decimal;
  pinRisk: boolean;
} {
  // Time to expiry in years
  const timeToExpiry = new Decimal(minutesToExpiry).dividedBy(525600); // Minutes in a year

  const params: BSParams = {
    spot,
    strike: toDecimal(strike),
    timeToExpiry,
    riskFreeRate: PRICING.RISK_FREE_RATE,
    volatility: new Decimal(0.50), // High IV on expiry
    optionType,
  };

  const currentPrice = calculateOptionPrice(params);
  const currentValue = currentPrice.times(quantity);
  const currentGreeks = calculateGreeks(params);

  // 1% spot move
  const moveSize = spot.times(0.01);
  const newSpot = optionType === 'CE' ? spot.plus(moveSize) : spot.minus(moveSize);

  const newParams = { ...params, spot: newSpot };
  const newPrice = calculateOptionPrice(newParams);
  const valueAfterMove = newPrice.times(quantity);

  // Gamma pain for short position
  const gammaPain = valueAfterMove.minus(currentValue);

  // Pin risk: Is spot very close to strike?
  const distanceToStrike = spot.minus(strike).abs();
  const pinRisk = distanceToStrike.dividedBy(spot).lessThan(0.005); // Within 0.5%

  return {
    currentValue,
    valueIf1PercentMove: valueAfterMove,
    gammaPain,
    pinRisk,
  };
}
