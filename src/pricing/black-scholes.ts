/**
 * Black-Scholes Options Pricing for NSE Options Paper Trading
 *
 * Implements the Black-Scholes-Merton model for European options.
 * Used for theoretical pricing and IV calculation.
 */

import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;
import { PRICING } from '../core/constants.js';
import { toDecimal, ZERO, ONE } from '../utils/decimal.js';
import type { BSParams, Greeks } from '../core/types.js';

// ============================================================================
// STANDARD NORMAL DISTRIBUTION
// ============================================================================

/**
 * Standard normal cumulative distribution function (CDF)
 * Uses Abramowitz and Stegun approximation (error < 7.5e-8)
 */
export function normCDF(x: Decimal): Decimal {
  const a1 = new Decimal('0.254829592');
  const a2 = new Decimal('-0.284496736');
  const a3 = new Decimal('1.421413741');
  const a4 = new Decimal('-1.453152027');
  const a5 = new Decimal('1.061405429');
  const p = new Decimal('0.3275911');

  const sign = x.isNegative() ? -1 : 1;
  const absX = x.abs();

  const t = ONE.dividedBy(ONE.plus(p.times(absX)));
  const t2 = t.times(t);
  const t3 = t2.times(t);
  const t4 = t3.times(t);
  const t5 = t4.times(t);

  const polynomial = a1.times(t)
    .plus(a2.times(t2))
    .plus(a3.times(t3))
    .plus(a4.times(t4))
    .plus(a5.times(t5));

  const expTerm = absX.negated().times(absX).dividedBy(2).exp();
  const y = ONE.minus(polynomial.times(expTerm));

  if (sign === 1) {
    return y;
  } else {
    return ONE.minus(y);
  }
}

/**
 * Standard normal probability density function (PDF)
 */
export function normPDF(x: Decimal): Decimal {
  const sqrt2Pi = new Decimal(Math.sqrt(2 * Math.PI));
  const exponent = x.negated().times(x).dividedBy(2);
  return exponent.exp().dividedBy(sqrt2Pi);
}

// ============================================================================
// BLACK-SCHOLES FORMULAS
// ============================================================================

/**
 * Calculate d1 and d2 parameters
 */
export function calculateD1D2(params: BSParams): { d1: Decimal; d2: Decimal } {
  const { spot, strike, timeToExpiry, riskFreeRate, volatility } = params;

  if (timeToExpiry.lessThanOrEqualTo(PRICING.MIN_TIME_TO_EXPIRY)) {
    // At expiry, use intrinsic value
    return { d1: ZERO, d2: ZERO };
  }

  const sqrtT = timeToExpiry.sqrt();
  const volSqrtT = volatility.times(sqrtT);

  if (volSqrtT.isZero()) {
    return { d1: ZERO, d2: ZERO };
  }

  // d1 = (ln(S/K) + (r + σ²/2) * T) / (σ * √T)
  const logSK = spot.dividedBy(strike).ln();
  const rPlusHalfVol2 = riskFreeRate.plus(volatility.times(volatility).dividedBy(2));
  const numerator = logSK.plus(rPlusHalfVol2.times(timeToExpiry));

  const d1 = numerator.dividedBy(volSqrtT);
  const d2 = d1.minus(volSqrtT);

  return { d1, d2 };
}

/**
 * Calculate call option price using Black-Scholes
 */
export function calculateCallPrice(params: BSParams): Decimal {
  const { spot, strike, timeToExpiry, riskFreeRate } = params;

  // At expiry, return intrinsic value
  if (timeToExpiry.lessThanOrEqualTo(PRICING.MIN_TIME_TO_EXPIRY)) {
    return Decimal.max(ZERO, spot.minus(strike));
  }

  const { d1, d2 } = calculateD1D2(params);

  // C = S * N(d1) - K * e^(-rT) * N(d2)
  const Nd1 = normCDF(d1);
  const Nd2 = normCDF(d2);
  const discountFactor = riskFreeRate.negated().times(timeToExpiry).exp();

  const price = spot.times(Nd1).minus(strike.times(discountFactor).times(Nd2));

  return Decimal.max(ZERO, price);
}

/**
 * Calculate put option price using Black-Scholes
 */
export function calculatePutPrice(params: BSParams): Decimal {
  const { spot, strike, timeToExpiry, riskFreeRate } = params;

  // At expiry, return intrinsic value
  if (timeToExpiry.lessThanOrEqualTo(PRICING.MIN_TIME_TO_EXPIRY)) {
    return Decimal.max(ZERO, strike.minus(spot));
  }

  const { d1, d2 } = calculateD1D2(params);

  // P = K * e^(-rT) * N(-d2) - S * N(-d1)
  const NnegD1 = normCDF(d1.negated());
  const NnegD2 = normCDF(d2.negated());
  const discountFactor = riskFreeRate.negated().times(timeToExpiry).exp();

  const price = strike.times(discountFactor).times(NnegD2).minus(spot.times(NnegD1));

  return Decimal.max(ZERO, price);
}

/**
 * Calculate option price (call or put)
 */
export function calculateOptionPrice(params: BSParams): Decimal {
  if (params.optionType === 'CE') {
    return calculateCallPrice(params);
  } else {
    return calculatePutPrice(params);
  }
}

// ============================================================================
// GREEKS CALCULATION
// ============================================================================

/**
 * Calculate all Greeks for an option
 */
export function calculateGreeks(params: BSParams): Greeks {
  const { spot, strike, timeToExpiry, riskFreeRate, volatility, optionType } = params;

  // Handle expiry edge case
  if (timeToExpiry.lessThanOrEqualTo(PRICING.MIN_TIME_TO_EXPIRY)) {
    const isITM = optionType === 'CE'
      ? spot.greaterThan(strike)
      : strike.greaterThan(spot);

    return {
      delta: isITM ? (optionType === 'CE' ? ONE : ONE.negated()) : ZERO,
      gamma: ZERO,
      theta: ZERO,
      vega: ZERO,
      rho: ZERO,
      iv: volatility.times(100),
    };
  }

  const { d1, d2 } = calculateD1D2(params);
  const sqrtT = timeToExpiry.sqrt();
  const discountFactor = riskFreeRate.negated().times(timeToExpiry).exp();
  const Nd1 = normCDF(d1);
  const Nd1PDF = normPDF(d1);
  const Nd2 = normCDF(d2);

  // Delta
  let delta: Decimal;
  if (optionType === 'CE') {
    delta = Nd1;
  } else {
    delta = Nd1.minus(1);
  }

  // Gamma (same for call and put)
  const gamma = Nd1PDF.dividedBy(spot.times(volatility).times(sqrtT));

  // Theta (per day)
  const thetaTerm1 = spot.times(Nd1PDF).times(volatility).dividedBy(sqrtT.times(2)).negated();

  let theta: Decimal;
  if (optionType === 'CE') {
    const thetaTerm2 = riskFreeRate.times(strike).times(discountFactor).times(Nd2);
    theta = thetaTerm1.minus(thetaTerm2);
  } else {
    const NnegD2 = normCDF(d2.negated());
    const thetaTerm2 = riskFreeRate.times(strike).times(discountFactor).times(NnegD2);
    theta = thetaTerm1.plus(thetaTerm2);
  }
  // Convert to daily theta
  theta = theta.dividedBy(PRICING.DAYS_IN_YEAR);

  // Vega (per 1% IV change)
  const vega = spot.times(sqrtT).times(Nd1PDF).dividedBy(100);

  // Rho (per 1% rate change)
  let rho: Decimal;
  if (optionType === 'CE') {
    rho = strike.times(timeToExpiry).times(discountFactor).times(Nd2).dividedBy(100);
  } else {
    const NnegD2 = normCDF(d2.negated());
    rho = strike.times(timeToExpiry).times(discountFactor).times(NnegD2).negated().dividedBy(100);
  }

  return {
    delta,
    gamma,
    theta,
    vega,
    rho,
    iv: volatility.times(100),  // Store as percentage
  };
}

/**
 * Calculate delta only (for quick calculations)
 */
export function calculateDelta(params: BSParams): Decimal {
  if (params.timeToExpiry.lessThanOrEqualTo(PRICING.MIN_TIME_TO_EXPIRY)) {
    const isITM = params.optionType === 'CE'
      ? params.spot.greaterThan(params.strike)
      : params.strike.greaterThan(params.spot);
    return isITM ? (params.optionType === 'CE' ? ONE : ONE.negated()) : ZERO;
  }

  const { d1 } = calculateD1D2(params);
  const Nd1 = normCDF(d1);

  return params.optionType === 'CE' ? Nd1 : Nd1.minus(1);
}

/**
 * Calculate gamma only
 */
export function calculateGamma(params: BSParams): Decimal {
  if (params.timeToExpiry.lessThanOrEqualTo(PRICING.MIN_TIME_TO_EXPIRY)) {
    return ZERO;
  }

  const { d1 } = calculateD1D2(params);
  const sqrtT = params.timeToExpiry.sqrt();
  const Nd1PDF = normPDF(d1);

  return Nd1PDF.dividedBy(params.spot.times(params.volatility).times(sqrtT));
}

/**
 * Calculate vega only (per 1% IV change)
 */
export function calculateVega(params: BSParams): Decimal {
  if (params.timeToExpiry.lessThanOrEqualTo(PRICING.MIN_TIME_TO_EXPIRY)) {
    return ZERO;
  }

  const { d1 } = calculateD1D2(params);
  const sqrtT = params.timeToExpiry.sqrt();
  const Nd1PDF = normPDF(d1);

  return params.spot.times(sqrtT).times(Nd1PDF).dividedBy(100);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Calculate intrinsic value
 */
export function calculateIntrinsicValue(
  spot: Decimal,
  strike: Decimal,
  optionType: 'CE' | 'PE'
): Decimal {
  if (optionType === 'CE') {
    return Decimal.max(ZERO, spot.minus(strike));
  } else {
    return Decimal.max(ZERO, strike.minus(spot));
  }
}

/**
 * Calculate extrinsic value (time value)
 */
export function calculateExtrinsicValue(
  optionPrice: Decimal,
  spot: Decimal,
  strike: Decimal,
  optionType: 'CE' | 'PE'
): Decimal {
  const intrinsic = calculateIntrinsicValue(spot, strike, optionType);
  return Decimal.max(ZERO, optionPrice.minus(intrinsic));
}

/**
 * Calculate moneyness (S/K ratio)
 */
export function calculateMoneyness(spot: Decimal, strike: Decimal): Decimal {
  if (strike.isZero()) return ZERO;
  return spot.dividedBy(strike);
}

/**
 * Check if option is ITM
 */
export function isITM(
  spot: Decimal,
  strike: Decimal,
  optionType: 'CE' | 'PE'
): boolean {
  if (optionType === 'CE') {
    return spot.greaterThan(strike);
  } else {
    return strike.greaterThan(spot);
  }
}

/**
 * Check if option is ATM (within 1% of spot)
 */
export function isATM(
  spot: Decimal,
  strike: Decimal,
  threshold = 0.01
): boolean {
  const ratio = spot.dividedBy(strike).minus(1).abs();
  return ratio.lessThan(threshold);
}

/**
 * Check if option is OTM
 */
export function isOTM(
  spot: Decimal,
  strike: Decimal,
  optionType: 'CE' | 'PE'
): boolean {
  return !isITM(spot, strike, optionType) && !isATM(spot, strike);
}
