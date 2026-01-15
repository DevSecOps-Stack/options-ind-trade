/**
 * Implied Volatility Calculator for NSE Options Paper Trading
 *
 * Uses Newton-Raphson iteration to solve for IV from market price.
 * Includes safeguards for edge cases and convergence issues.
 */

import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;
import { PRICING } from '../core/constants.js';
import { IVCalculationError } from '../core/errors.js';
import { toDecimal, ZERO, ONE } from '../utils/decimal.js';
import {
  calculateOptionPrice,
  calculateVega,
  calculateIntrinsicValue,
  normCDF,
  calculateD1D2,
} from './black-scholes.js';
import type { BSParams } from '../core/types.js';

// ============================================================================
// IV CALCULATION
// ============================================================================

/**
 * Calculate implied volatility using Newton-Raphson method
 *
 * @param marketPrice - Observed market price of the option
 * @param spot - Current spot price
 * @param strike - Strike price
 * @param timeToExpiry - Time to expiry in years
 * @param riskFreeRate - Risk-free rate as decimal
 * @param optionType - 'CE' or 'PE'
 * @returns Implied volatility as decimal (e.g., 0.20 for 20%)
 */
export function calculateIV(
  marketPrice: Decimal,
  spot: Decimal,
  strike: Decimal,
  timeToExpiry: Decimal,
  riskFreeRate: Decimal,
  optionType: 'CE' | 'PE'
): Decimal {
  // Validate inputs
  if (marketPrice.lessThanOrEqualTo(ZERO)) {
    return ZERO;
  }

  if (spot.lessThanOrEqualTo(ZERO) || strike.lessThanOrEqualTo(ZERO)) {
    throw new IVCalculationError('invalid inputs', 'spot and strike must be positive');
  }

  if (timeToExpiry.lessThanOrEqualTo(PRICING.MIN_TIME_TO_EXPIRY)) {
    // At expiry, IV is undefined/irrelevant
    return PRICING.IV_INITIAL_GUESS;
  }

  // Check if price is below intrinsic value (arbitrage)
  const intrinsic = calculateIntrinsicValue(spot, strike, optionType);
  if (marketPrice.lessThan(intrinsic)) {
    // Price below intrinsic - shouldn't happen in normal markets
    // Return high IV to indicate something is off
    return PRICING.IV_MAX;
  }

  // Check if price is too high (above spot for calls, above strike for puts)
  const maxPrice = optionType === 'CE' ? spot : strike;
  if (marketPrice.greaterThan(maxPrice)) {
    return PRICING.IV_MAX;
  }

  // Newton-Raphson iteration
  let volatility = PRICING.IV_INITIAL_GUESS;
  let iterations = 0;

  while (iterations < PRICING.IV_NEWTON_ITERATIONS) {
    const params: BSParams = {
      spot,
      strike,
      timeToExpiry,
      riskFreeRate,
      volatility,
      optionType,
    };

    const theoreticalPrice = calculateOptionPrice(params);
    const priceDiff = theoreticalPrice.minus(marketPrice);

    // Check convergence
    if (priceDiff.abs().lessThan(PRICING.IV_NEWTON_PRECISION)) {
      break;
    }

    // Calculate vega
    const vega = calculateVega(params);

    // Avoid division by zero
    if (vega.abs().lessThan(new Decimal('0.00001'))) {
      // Vega too small, use bisection fallback
      return calculateIVBisection(marketPrice, spot, strike, timeToExpiry, riskFreeRate, optionType);
    }

    // Newton-Raphson step: vol_new = vol - f(vol) / f'(vol)
    // f(vol) = BS_price(vol) - market_price
    // f'(vol) = vega * 100 (since our vega is per 1% change)
    const adjustment = priceDiff.dividedBy(vega.times(100));
    volatility = volatility.minus(adjustment);

    // Clamp to valid range
    volatility = Decimal.max(PRICING.IV_MIN, Decimal.min(PRICING.IV_MAX, volatility));

    iterations++;
  }

  // Check if we converged
  if (iterations >= PRICING.IV_NEWTON_ITERATIONS) {
    // Didn't converge, try bisection as fallback
    return calculateIVBisection(marketPrice, spot, strike, timeToExpiry, riskFreeRate, optionType);
  }

  return volatility;
}

/**
 * Calculate IV using bisection method (fallback for convergence issues)
 */
export function calculateIVBisection(
  marketPrice: Decimal,
  spot: Decimal,
  strike: Decimal,
  timeToExpiry: Decimal,
  riskFreeRate: Decimal,
  optionType: 'CE' | 'PE'
): Decimal {
  let low = PRICING.IV_MIN;
  let high = PRICING.IV_MAX;
  let mid = low.plus(high).dividedBy(2);

  const maxIterations = 100;
  let iterations = 0;

  while (iterations < maxIterations && high.minus(low).greaterThan(PRICING.IV_NEWTON_PRECISION)) {
    const params: BSParams = {
      spot,
      strike,
      timeToExpiry,
      riskFreeRate,
      volatility: mid,
      optionType,
    };

    const price = calculateOptionPrice(params);
    const diff = price.minus(marketPrice);

    if (diff.abs().lessThan(PRICING.IV_NEWTON_PRECISION)) {
      break;
    }

    if (diff.isPositive()) {
      high = mid;
    } else {
      low = mid;
    }

    mid = low.plus(high).dividedBy(2);
    iterations++;
  }

  return mid;
}

/**
 * Calculate IV with Brenner-Subrahmanyam approximation as initial guess
 * Better initial guess for faster convergence
 */
export function calculateIVWithApproximation(
  marketPrice: Decimal,
  spot: Decimal,
  strike: Decimal,
  timeToExpiry: Decimal,
  riskFreeRate: Decimal,
  optionType: 'CE' | 'PE'
): Decimal {
  // Brenner-Subrahmanyam approximation for ATM options
  // σ ≈ √(2π/T) × (C/S) for ATM calls
  const sqrtT = timeToExpiry.sqrt();

  if (sqrtT.isZero()) {
    return PRICING.IV_INITIAL_GUESS;
  }

  // Use Corrado-Miller approximation for general case
  const forwardPrice = spot.times(riskFreeRate.times(timeToExpiry).exp());
  const x = forwardPrice.minus(strike);
  const pricePlusX = marketPrice.minus(x.dividedBy(2));

  if (pricePlusX.lessThanOrEqualTo(ZERO)) {
    return PRICING.IV_INITIAL_GUESS;
  }

  const sqrt2Pi = new Decimal(Math.sqrt(2 * Math.PI));
  const approxIV = sqrt2Pi.dividedBy(sqrtT).times(pricePlusX).dividedBy(forwardPrice);

  // Clamp to valid range
  const initialGuess = Decimal.max(PRICING.IV_MIN, Decimal.min(PRICING.IV_MAX, approxIV));

  // Now use Newton-Raphson with better initial guess
  return calculateIV(marketPrice, spot, strike, timeToExpiry, riskFreeRate, optionType);
}

// ============================================================================
// IV SURFACE
// ============================================================================

export interface IVPoint {
  strike: number;
  expiry: Date;
  optionType: 'CE' | 'PE';
  iv: Decimal;
  marketPrice: Decimal;
  theoreticalPrice: Decimal;
  moneyness: Decimal;
  timeToExpiry: Decimal;
}

export interface IVSurface {
  underlying: string;
  spotPrice: Decimal;
  timestamp: Date;
  points: IVPoint[];
}

/**
 * Calculate IV surface from market prices
 */
export function calculateIVSurface(
  underlying: string,
  spotPrice: Decimal,
  riskFreeRate: Decimal,
  optionPrices: Array<{
    strike: number;
    expiry: Date;
    optionType: 'CE' | 'PE';
    marketPrice: Decimal;
    timeToExpiry: Decimal;
  }>
): IVSurface {
  const points: IVPoint[] = [];

  for (const option of optionPrices) {
    const strike = toDecimal(option.strike);

    try {
      const iv = calculateIV(
        option.marketPrice,
        spotPrice,
        strike,
        option.timeToExpiry,
        riskFreeRate,
        option.optionType
      );

      const params: BSParams = {
        spot: spotPrice,
        strike,
        timeToExpiry: option.timeToExpiry,
        riskFreeRate,
        volatility: iv,
        optionType: option.optionType,
      };

      const theoreticalPrice = calculateOptionPrice(params);
      const moneyness = spotPrice.dividedBy(strike);

      points.push({
        strike: option.strike,
        expiry: option.expiry,
        optionType: option.optionType,
        iv,
        marketPrice: option.marketPrice,
        theoreticalPrice,
        moneyness,
        timeToExpiry: option.timeToExpiry,
      });
    } catch {
      // Skip invalid points
    }
  }

  return {
    underlying,
    spotPrice,
    timestamp: new Date(),
    points,
  };
}

/**
 * Get ATM IV from surface
 */
export function getATMIV(surface: IVSurface, expiry: Date): Decimal | null {
  // Find points closest to ATM for this expiry
  const expiryPoints = surface.points.filter(
    p => p.expiry.getTime() === expiry.getTime()
  );

  if (expiryPoints.length === 0) return null;

  // Sort by moneyness distance from 1
  expiryPoints.sort((a, b) =>
    a.moneyness.minus(1).abs().comparedTo(b.moneyness.minus(1).abs())
  );

  // Return average of closest CE and PE
  const atmCE = expiryPoints.find(p => p.optionType === 'CE');
  const atmPE = expiryPoints.find(p => p.optionType === 'PE');

  if (atmCE && atmPE) {
    return atmCE.iv.plus(atmPE.iv).dividedBy(2);
  }

  return atmCE?.iv ?? atmPE?.iv ?? null;
}

/**
 * Get IV skew (difference between OTM put and OTM call IV)
 */
export function getIVSkew(surface: IVSurface, expiry: Date, distance = 0.05): Decimal | null {
  const expiryPoints = surface.points.filter(
    p => p.expiry.getTime() === expiry.getTime()
  );

  if (expiryPoints.length < 2) return null;

  // Find OTM put (moneyness < 1 - distance)
  const otmPut = expiryPoints.find(
    p => p.optionType === 'PE' && p.moneyness.lessThan(1 - distance)
  );

  // Find OTM call (moneyness > 1 + distance)
  const otmCall = expiryPoints.find(
    p => p.optionType === 'CE' && p.moneyness.greaterThan(1 + distance)
  );

  if (!otmPut || !otmCall) return null;

  return otmPut.iv.minus(otmCall.iv);
}

/**
 * Interpolate IV for a specific strike
 */
export function interpolateIV(
  surface: IVSurface,
  strike: number,
  expiry: Date,
  optionType: 'CE' | 'PE'
): Decimal | null {
  const expiryPoints = surface.points.filter(
    p => p.expiry.getTime() === expiry.getTime() && p.optionType === optionType
  );

  if (expiryPoints.length === 0) return null;
  if (expiryPoints.length === 1) return expiryPoints[0]!.iv;

  // Sort by strike
  expiryPoints.sort((a, b) => a.strike - b.strike);

  // Find bracketing points
  let lower: IVPoint | null = null;
  let upper: IVPoint | null = null;

  for (let i = 0; i < expiryPoints.length - 1; i++) {
    if (expiryPoints[i]!.strike <= strike && expiryPoints[i + 1]!.strike >= strike) {
      lower = expiryPoints[i]!;
      upper = expiryPoints[i + 1]!;
      break;
    }
  }

  if (!lower || !upper) {
    // Strike outside range, return nearest
    if (strike < expiryPoints[0]!.strike) return expiryPoints[0]!.iv;
    return expiryPoints[expiryPoints.length - 1]!.iv;
  }

  // Linear interpolation
  const weight = (strike - lower.strike) / (upper.strike - lower.strike);
  return lower.iv.plus(upper.iv.minus(lower.iv).times(weight));
}
