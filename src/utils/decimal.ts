/**
 * Decimal.js Utilities for NSE Options Paper Trading
 *
 * CRITICAL: Always use Decimal for monetary calculations.
 * JavaScript's floating point arithmetic will cause P&L errors.
 */

import Decimal from 'decimal.js';

// Re-export Decimal class and type for use throughout the codebase
export { Decimal };
export type DecimalValue = Decimal;
import { TICK_SIZE } from '../core/constants.js';

// Configure Decimal.js for financial calculations
Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9,
  toExpPos: 9,
});

// ============================================================================
// CONVERSION UTILITIES
// ============================================================================

/**
 * Convert number to Decimal safely
 */
export function toDecimal(value: number | string | Decimal): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  return new Decimal(value);
}

/**
 * Convert Decimal to number (use with caution, only for display)
 */
export function toNumber(value: Decimal): number {
  return value.toNumber();
}

/**
 * Convert Decimal to formatted string for display
 */
export function formatDecimal(value: Decimal, decimals = 2): string {
  return value.toFixed(decimals);
}

/**
 * Convert Decimal to INR formatted string
 */
export function formatINR(value: Decimal): string {
  const num = value.toNumber();
  const formatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return formatter.format(num);
}

/**
 * Format with sign (for P&L display)
 */
export function formatWithSign(value: Decimal): string {
  const sign = value.isPositive() ? '+' : '';
  return `${sign}${formatINR(value)}`;
}

// ============================================================================
// ROUNDING UTILITIES
// ============================================================================

/**
 * Round to tick size (0.05 for options)
 */
export function roundToTick(price: Decimal): Decimal {
  return price.dividedBy(TICK_SIZE).round().times(TICK_SIZE);
}

/**
 * Round up to tick size
 */
export function roundUpToTick(price: Decimal): Decimal {
  return price.dividedBy(TICK_SIZE).ceil().times(TICK_SIZE);
}

/**
 * Round down to tick size
 */
export function roundDownToTick(price: Decimal): Decimal {
  return price.dividedBy(TICK_SIZE).floor().times(TICK_SIZE);
}

/**
 * Round to 2 decimal places (for P&L)
 */
export function roundToPaisa(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

// ============================================================================
// COMPARISON UTILITIES
// ============================================================================

/**
 * Check if two decimals are equal within epsilon
 */
export function decimalEquals(a: Decimal, b: Decimal, epsilon = 0.0001): boolean {
  return a.minus(b).abs().lessThan(epsilon);
}

/**
 * Get the maximum of multiple decimals
 */
export function decimalMax(...values: Decimal[]): Decimal {
  return values.reduce((max, val) => Decimal.max(max, val));
}

/**
 * Get the minimum of multiple decimals
 */
export function decimalMin(...values: Decimal[]): Decimal {
  return values.reduce((min, val) => Decimal.min(min, val));
}

/**
 * Clamp value between min and max
 */
export function decimalClamp(value: Decimal, min: Decimal, max: Decimal): Decimal {
  return Decimal.max(min, Decimal.min(max, value));
}

// ============================================================================
// ARITHMETIC UTILITIES
// ============================================================================

/**
 * Sum an array of decimals
 */
export function decimalSum(values: Decimal[]): Decimal {
  return values.reduce((sum, val) => sum.plus(val), new Decimal(0));
}

/**
 * Calculate average of decimals
 */
export function decimalAverage(values: Decimal[]): Decimal {
  if (values.length === 0) return new Decimal(0);
  return decimalSum(values).dividedBy(values.length);
}

/**
 * Calculate weighted average
 */
export function weightedAverage(
  values: Array<{ value: Decimal; weight: number }>
): Decimal {
  const totalWeight = values.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight === 0) return new Decimal(0);

  const weightedSum = values.reduce(
    (sum, v) => sum.plus(v.value.times(v.weight)),
    new Decimal(0)
  );

  return weightedSum.dividedBy(totalWeight);
}

/**
 * Calculate percentage change
 */
export function percentChange(oldValue: Decimal, newValue: Decimal): Decimal {
  if (oldValue.isZero()) return new Decimal(0);
  return newValue.minus(oldValue).dividedBy(oldValue).times(100);
}

// ============================================================================
// FINANCIAL CALCULATIONS
// ============================================================================

/**
 * Calculate P&L for a position
 */
export function calculatePnL(
  entryPrice: Decimal,
  currentPrice: Decimal,
  quantity: number,
  isLong: boolean
): Decimal {
  const priceDiff = currentPrice.minus(entryPrice);
  const direction = isLong ? 1 : -1;
  return priceDiff.times(quantity).times(direction);
}

/**
 * Calculate average entry price after adding to position
 */
export function calculateAveragePrice(
  existingQty: number,
  existingAvgPrice: Decimal,
  newQty: number,
  newPrice: Decimal
): Decimal {
  const totalQty = existingQty + newQty;
  if (totalQty === 0) return new Decimal(0);

  const existingValue = existingAvgPrice.times(existingQty);
  const newValue = newPrice.times(newQty);

  return existingValue.plus(newValue).dividedBy(totalQty);
}

/**
 * Calculate notional value
 */
export function calculateNotional(
  price: Decimal,
  quantity: number,
  lotSize: number
): Decimal {
  return price.times(quantity).times(lotSize);
}

// ============================================================================
// SERIALIZATION
// ============================================================================

/**
 * Serialize Decimal for JSON storage
 */
export function serializeDecimal(value: Decimal): string {
  return value.toString();
}

/**
 * Deserialize Decimal from JSON storage
 */
export function deserializeDecimal(value: string): Decimal {
  return new Decimal(value);
}

/**
 * JSON replacer for Decimal values
 */
export function decimalReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Decimal) {
    return { __type: 'Decimal', value: value.toString() };
  }
  return value;
}

/**
 * JSON reviver for Decimal values
 */
export function decimalReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['__type'] === 'Decimal'
  ) {
    return new Decimal((value as Record<string, string>)['value']!);
  }
  return value;
}

/**
 * Stringify object with Decimal support
 */
export function stringifyWithDecimal(obj: unknown): string {
  return JSON.stringify(obj, decimalReplacer);
}

/**
 * Parse JSON with Decimal support
 */
export function parseWithDecimal<T>(json: string): T {
  return JSON.parse(json, decimalReviver) as T;
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Check if value is a valid Decimal
 */
export function isValidDecimal(value: unknown): value is Decimal {
  return value instanceof Decimal && value.isFinite();
}

/**
 * Check if value is positive
 */
export function isPositive(value: Decimal): boolean {
  return value.isPositive() && !value.isZero();
}

/**
 * Check if value is negative
 */
export function isNegative(value: Decimal): boolean {
  return value.isNegative();
}

/**
 * Check if value is zero
 */
export function isZero(value: Decimal): boolean {
  return value.isZero();
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const HUNDRED = new Decimal(100);
