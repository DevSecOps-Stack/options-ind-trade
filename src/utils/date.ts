/**
 * Date Utilities for NSE Options Paper Trading
 *
 * Handles IST timezone, expiry calculations, and trading hours.
 */

import {
  format,
  parse,
  isThursday,
  nextThursday,
  previousThursday,
  lastDayOfMonth,
  isBefore,
  isAfter,
  differenceInDays,
  differenceInMinutes,
  differenceInSeconds,
  addDays,
  startOfDay,
  setHours,
  setMinutes,
} from 'date-fns';
import { TRADING_HOURS, EXPIRY_TIMINGS, PRICING } from '../core/constants.js';
import Decimal from 'decimal.js';

// ============================================================================
// IST TIMEZONE HANDLING
// ============================================================================

/**
 * IST offset from UTC in minutes
 */
const IST_OFFSET_MINUTES = 330; // +5:30

/**
 * Convert Date to IST
 */
export function toIST(date: Date): Date {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + IST_OFFSET_MINUTES * 60000);
}

/**
 * Get current time in IST
 */
export function nowIST(): Date {
  return toIST(new Date());
}

/**
 * Format date in IST
 */
export function formatIST(date: Date, formatStr = 'yyyy-MM-dd HH:mm:ss'): string {
  return format(toIST(date), formatStr);
}

// ============================================================================
// TRADING HOURS
// ============================================================================

/**
 * Parse time string (HH:mm) to Date object for today
 */
function parseTimeToday(timeStr: string): Date {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const today = nowIST();
  return setMinutes(setHours(today, hours ?? 0), minutes ?? 0);
}

/**
 * Check if current time is within trading hours
 */
export function isMarketOpen(): boolean {
  const now = nowIST();
  const marketOpen = parseTimeToday(TRADING_HOURS.MARKET_OPEN);
  const marketClose = parseTimeToday(TRADING_HOURS.MARKET_CLOSE);

  return isAfter(now, marketOpen) && isBefore(now, marketClose);
}

/**
 * Check if it's pre-market session
 */
export function isPreMarket(): boolean {
  const now = nowIST();
  const preOpenStart = parseTimeToday(TRADING_HOURS.PRE_OPEN_START);
  const preOpenEnd = parseTimeToday(TRADING_HOURS.PRE_OPEN_END);

  return isAfter(now, preOpenStart) && isBefore(now, preOpenEnd);
}

/**
 * Get time until market opens (in minutes)
 */
export function minutesToMarketOpen(): number {
  const now = nowIST();
  const marketOpen = parseTimeToday(TRADING_HOURS.MARKET_OPEN);

  if (isAfter(now, marketOpen)) {
    // Market already open, return time to next day's open
    const tomorrow = addDays(marketOpen, 1);
    return differenceInMinutes(tomorrow, now);
  }

  return differenceInMinutes(marketOpen, now);
}

/**
 * Get time until market closes (in minutes)
 */
export function minutesToMarketClose(): number {
  const now = nowIST();
  const marketClose = parseTimeToday(TRADING_HOURS.MARKET_CLOSE);

  if (isBefore(now, marketClose)) {
    return differenceInMinutes(marketClose, now);
  }

  return 0;
}

/**
 * Check if today is a trading day (not weekend)
 * Note: This doesn't account for NSE holidays
 */
export function isTradingDay(date: Date = new Date()): boolean {
  const day = toIST(date).getDay();
  return day !== 0 && day !== 6; // Not Sunday (0) or Saturday (6)
}

// ============================================================================
// EXPIRY CALCULATIONS
// ============================================================================

/**
 * Get the weekly expiry date (Thursday)
 */
export function getWeeklyExpiry(referenceDate: Date = new Date()): Date {
  const ist = toIST(referenceDate);

  if (isThursday(ist)) {
    // If today is Thursday, it's expiry day
    return startOfDay(ist);
  }

  // Get next Thursday
  return startOfDay(nextThursday(ist));
}

/**
 * Get the monthly expiry date (last Thursday of month)
 */
export function getMonthlyExpiry(referenceDate: Date = new Date()): Date {
  const ist = toIST(referenceDate);
  const lastDay = lastDayOfMonth(ist);

  // Find last Thursday
  let thursday = previousThursday(addDays(lastDay, 1));
  if (isAfter(thursday, lastDay)) {
    thursday = previousThursday(thursday);
  }

  return startOfDay(thursday);
}

/**
 * Get next N expiries (for subscription)
 */
export function getNextExpiries(count: number, referenceDate: Date = new Date()): Date[] {
  const expiries: Date[] = [];
  let current = referenceDate;

  while (expiries.length < count) {
    const expiry = getWeeklyExpiry(current);

    // Avoid duplicates
    const existing = expiries.find(
      e => e.getTime() === expiry.getTime()
    );

    if (!existing && isAfter(expiry, startOfDay(toIST(referenceDate)))) {
      expiries.push(expiry);
    }

    current = addDays(expiry, 1);
  }

  return expiries;
}

/**
 * Check if a date is an expiry day
 */
export function isExpiryDay(date: Date = new Date()): boolean {
  const ist = toIST(date);
  return isThursday(ist);
}

/**
 * Format expiry date for display
 */
export function formatExpiry(expiry: Date): string {
  return format(toIST(expiry), 'ddMMMyyyy').toUpperCase();
}

/**
 * Parse expiry string (e.g., "25JAN2024") to Date
 */
export function parseExpiry(expiryStr: string): Date {
  return parse(expiryStr, 'ddMMMyyyy', new Date());
}

// ============================================================================
// TIME TO EXPIRY
// ============================================================================

/**
 * Calculate days to expiry
 */
export function daysToExpiry(expiry: Date, referenceDate: Date = new Date()): number {
  const ist = toIST(referenceDate);
  const expiryIST = toIST(expiry);
  return Math.max(0, differenceInDays(expiryIST, ist));
}

/**
 * Calculate time to expiry in years (for Black-Scholes)
 */
export function timeToExpiryYears(expiry: Date, referenceDate: Date = new Date()): Decimal {
  const ist = toIST(referenceDate);
  const expiryTime = setMinutes(setHours(toIST(expiry), 15), 30); // Expiry at 15:30

  const diffSeconds = Math.max(0, differenceInSeconds(expiryTime, ist));
  const years = diffSeconds / (PRICING.DAYS_IN_YEAR * 24 * 60 * 60);

  return Decimal.max(PRICING.MIN_TIME_TO_EXPIRY, new Decimal(years));
}

/**
 * Calculate trading days to expiry
 */
export function tradingDaysToExpiry(expiry: Date, referenceDate: Date = new Date()): number {
  let days = 0;
  let current = startOfDay(toIST(referenceDate));
  const expiryStart = startOfDay(toIST(expiry));

  while (isBefore(current, expiryStart)) {
    current = addDays(current, 1);
    if (isTradingDay(current)) {
      days++;
    }
  }

  return days;
}

// ============================================================================
// TRADING SYMBOL GENERATION
// ============================================================================

/**
 * Generate trading symbol for options
 * Format: NIFTY24JAN25000CE
 */
export function generateOptionSymbol(
  underlying: string,
  expiry: Date,
  strike: number,
  optionType: 'CE' | 'PE'
): string {
  const year = format(expiry, 'yy');
  const month = format(expiry, 'MMM').toUpperCase();
  const day = format(expiry, 'dd');

  // Weekly options include day
  return `${underlying}${year}${month}${day}${strike}${optionType}`;
}

/**
 * Generate trading symbol for futures
 * Format: NIFTY24JANFUT
 */
export function generateFuturesSymbol(underlying: string, expiry: Date): string {
  const year = format(expiry, 'yy');
  const month = format(expiry, 'MMM').toUpperCase();

  return `${underlying}${year}${month}FUT`;
}

/**
 * Parse trading symbol to extract components
 */
export function parseSymbol(symbol: string): {
  underlying: string;
  expiry: Date;
  strike?: number;
  optionType?: 'CE' | 'PE';
  isFutures: boolean;
} | null {
  // Futures: NIFTY24JANFUT
  const futuresMatch = symbol.match(/^([A-Z]+)(\d{2})([A-Z]{3})FUT$/);
  if (futuresMatch) {
    const [, underlying, year, month] = futuresMatch;
    const expiry = parse(`01${month}20${year}`, 'ddMMMyyyy', new Date());
    return {
      underlying: underlying!,
      expiry: getMonthlyExpiry(expiry),
      isFutures: true,
    };
  }

  // Options: NIFTY24JAN2525000CE
  const optionsMatch = symbol.match(/^([A-Z]+)(\d{2})([A-Z]{3})(\d{2})(\d+)(CE|PE)$/);
  if (optionsMatch) {
    const [, underlying, year, month, day, strike, optionType] = optionsMatch;
    const expiry = parse(`${day}${month}20${year}`, 'ddMMMyyyy', new Date());
    return {
      underlying: underlying!,
      expiry,
      strike: parseInt(strike!, 10),
      optionType: optionType as 'CE' | 'PE',
      isFutures: false,
    };
  }

  return null;
}

// ============================================================================
// UTILITY
// ============================================================================

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get timestamp string for logging
 */
export function timestamp(): string {
  return formatIST(new Date(), 'HH:mm:ss.SSS');
}

/**
 * Check if date is today
 */
export function isToday(date: Date): boolean {
  const today = startOfDay(nowIST());
  const target = startOfDay(toIST(date));
  return today.getTime() === target.getTime();
}
