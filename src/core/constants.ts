/**
 * Constants for NSE Options Paper Trading System
 *
 * These values are based on actual NSE/Zerodha specifications.
 * Update if exchange rules change.
 */

import Decimal from 'decimal.js';
import type { Underlying } from './types.js';

// ============================================================================
// INSTRUMENT SPECIFICATIONS
// ============================================================================

/**
 * Lot sizes for index derivatives (as of 2024)
 */
export const LOT_SIZES: Record<Underlying, number> = {
  NIFTY: 25,       // Was 50, changed to 25 in Apr 2023
  BANKNIFTY: 15,   // Was 25, changed to 15 in Apr 2023
  FINNIFTY: 25,
} as const;

/**
 * Strike interval for options
 */
export const STRIKE_INTERVALS: Record<Underlying, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  FINNIFTY: 50,
} as const;

/**
 * Tick size for options pricing
 */
export const TICK_SIZE = new Decimal('0.05');

/**
 * Instrument tokens for spot indices (Zerodha)
 */
export const SPOT_TOKENS: Record<Underlying, number> = {
  NIFTY: 256265,      // NIFTY 50 index
  BANKNIFTY: 260105,  // NIFTY BANK index
  FINNIFTY: 257801,   // NIFTY FIN SERVICE index
} as const;

/**
 * Exchange segments
 */
export const EXCHANGE_SEGMENTS = {
  NFO: 'NFO',    // F&O segment
  NSE: 'NSE',    // Cash segment (for spot)
} as const;

// ============================================================================
// TRADING HOURS
// ============================================================================

export const TRADING_HOURS = {
  MARKET_OPEN: '09:15',
  MARKET_CLOSE: '15:30',
  PRE_OPEN_START: '09:00',
  PRE_OPEN_END: '09:08',
  // Block deal window
  BLOCK_DEAL_MORNING_START: '09:15',
  BLOCK_DEAL_MORNING_END: '09:50',
  BLOCK_DEAL_AFTERNOON_START: '14:00',
  BLOCK_DEAL_AFTERNOON_END: '14:30',
} as const;

/**
 * Expiry day timings (weekly options expire at 15:30)
 */
export const EXPIRY_TIMINGS = {
  WEEKLY_EXPIRY_DAY: 4,  // Thursday (0 = Sunday)
  MONTHLY_EXPIRY_WEEK: -1, // Last Thursday of month
  EXPIRY_TIME: '15:30',
} as const;

// ============================================================================
// MARGIN CONSTANTS
// ============================================================================

/**
 * Base margin percentages (approximate SPAN)
 * Actual SPAN is more complex, this is a reasonable approximation
 */
export const MARGIN_PERCENTAGES = {
  // Short option margins (% of notional)
  ATM_SHORT: 0.18,        // 18% for ATM
  NEAR_OTM_SHORT: 0.14,   // 14% for slightly OTM (< 5%)
  OTM_SHORT: 0.10,        // 10% for OTM (5-10%)
  DEEP_OTM_SHORT: 0.07,   // 7% for deep OTM (> 10%)

  // Exposure margin
  EXPOSURE_MARGIN: 0.03,  // 3% of notional

  // Futures margin
  FUTURES_INITIAL: 0.12,  // 12% initial margin
  FUTURES_EXPOSURE: 0.03, // 3% exposure

  // Strategy benefits
  SPREAD_BENEFIT: 0.70,   // 70% reduction for proper spreads
} as const;

/**
 * Moneyness thresholds for margin calculation
 */
export const MONEYNESS_THRESHOLDS = {
  ATM: 0.02,        // Within 2% of spot
  NEAR_OTM: 0.05,   // 2-5% from spot
  OTM: 0.10,        // 5-10% from spot
  DEEP_OTM: 0.15,   // > 10% from spot
} as const;

// ============================================================================
// SLIPPAGE CONSTANTS
// ============================================================================

export const SLIPPAGE = {
  // Base slippage (in rupees)
  BASE_SLIPPAGE: new Decimal('0.05'),

  // Velocity thresholds (points per second for NIFTY)
  VELOCITY_LOW: 5,
  VELOCITY_MEDIUM: 15,
  VELOCITY_HIGH: 30,
  VELOCITY_EXTREME: 50,

  // Slippage multipliers
  VELOCITY_MULTIPLIER: 0.01,   // 1 paisa per point/sec
  IV_MULTIPLIER: 0.02,         // 2 paisa per IV point above 25
  SIZE_MULTIPLIER: 0.10,       // 10% extra per lot above avg
  DEPTH_MULTIPLIER: 0.50,      // 50% extra if eating into book

  // Spread thresholds
  WIDE_SPREAD_THRESHOLD: 0.02, // > 2% spread is wide

  // IV threshold for extra slippage
  HIGH_IV_THRESHOLD: 25,
} as const;

// ============================================================================
// LATENCY CONSTANTS
// ============================================================================

export const LATENCY = {
  MIN_MS: 100,
  MAX_MS: 500,
  AVERAGE_MS: 250,

  // Extra latency during volatility
  HIGH_VOLATILITY_EXTRA_MS: 200,

  // Network retry parameters
  WEBSOCKET_RECONNECT_BASE_MS: 1000,
  WEBSOCKET_RECONNECT_MAX_MS: 30000,
  WEBSOCKET_RECONNECT_MULTIPLIER: 2,
} as const;

// ============================================================================
// RISK CONSTANTS
// ============================================================================

export const RISK = {
  // Kill switch defaults
  DEFAULT_MAX_DAILY_LOSS: 50000,          // ₹50,000
  DEFAULT_MAX_DAILY_LOSS_PCT: 0.05,       // 5%
  DEFAULT_MARGIN_BREACH_THRESHOLD: 0.90,  // 90% utilized

  // Position limits
  MAX_LOTS_PER_UNDERLYING: 50,
  MAX_OPEN_ORDERS: 100,
  MAX_POSITIONS: 50,

  // Expiry day adjustments
  EXPIRY_DAY_MARGIN_MULTIPLIER: 1.5,

  // Warning thresholds
  MARGIN_WARNING_THRESHOLD: 0.75,  // 75% warning
  PNL_WARNING_THRESHOLD: 0.03,     // 3% daily loss warning
} as const;

// ============================================================================
// OPTIONS PRICING CONSTANTS
// ============================================================================

export const PRICING = {
  // Risk-free rate (RBI repo rate approximate)
  RISK_FREE_RATE: new Decimal('0.065'),  // 6.5%

  // IV calculation
  IV_MIN: new Decimal('0.05'),   // 5% minimum IV
  IV_MAX: new Decimal('1.50'),   // 150% maximum IV
  IV_INITIAL_GUESS: new Decimal('0.20'),  // 20% initial guess
  IV_NEWTON_ITERATIONS: 100,
  IV_NEWTON_PRECISION: new Decimal('0.0001'),

  // IV inflation during fast moves
  IV_INFLATION_BASE: 1.0,
  IV_INFLATION_MEDIUM: 1.15,  // 15% inflation
  IV_INFLATION_HIGH: 1.30,    // 30% inflation
  IV_INFLATION_EXTREME: 1.50, // 50% inflation

  // Days in year for theta calculation
  DAYS_IN_YEAR: 365,
  TRADING_DAYS_IN_YEAR: 252,

  // Minimum time to expiry (avoid division issues)
  MIN_TIME_TO_EXPIRY: new Decimal('0.0001'),
} as const;

// ============================================================================
// DATABASE CONSTANTS
// ============================================================================

export const DATABASE = {
  DEFAULT_PATH: './data/paper-trading.db',
  BACKUP_PATH: './data/backups/',
  JOURNAL_MODE: 'WAL',
  CACHE_SIZE: 10000,
  BUSY_TIMEOUT: 5000,
} as const;

// ============================================================================
// WEBHOOK CONSTANTS
// ============================================================================

export const WEBHOOK = {
  DEFAULT_PORT: 3000,
  RATE_LIMIT_WINDOW_MS: 60000,  // 1 minute
  RATE_LIMIT_MAX_REQUESTS: 60,  // 60 requests per minute
  REQUEST_TIMEOUT_MS: 30000,
} as const;

// ============================================================================
// LOGGING CONSTANTS
// ============================================================================

export const LOGGING = {
  DEFAULT_LEVEL: 'info',
  FILE_MAX_SIZE: '10m',
  FILE_MAX_FILES: 10,
  LOG_DIR: './logs/',
} as const;

// ============================================================================
// ZERODHA API CONSTANTS
// ============================================================================

export const ZERODHA = {
  // WebSocket modes
  MODE_LTP: 'ltp',
  MODE_QUOTE: 'quote',
  MODE_FULL: 'full',

  // Endpoints
  API_BASE: 'https://api.kite.trade',
  WS_BASE: 'wss://ws.kite.trade',

  // Limits
  MAX_SUBSCRIPTIONS: 3000,
  MAX_SUBSCRIPTIONS_PER_MESSAGE: 100,

  // Instrument master
  INSTRUMENT_MASTER_URL: 'https://api.kite.trade/instruments',

  // Rate limits
  RATE_LIMIT_PER_SECOND: 10,
  RATE_LIMIT_BURST: 20,
} as const;

// ============================================================================
// ORDER CONSTANTS
// ============================================================================

export const ORDERS = {
  // Order validity
  VALIDITY_DAY: 'DAY',
  VALIDITY_IOC: 'IOC',

  // Order status check interval
  STATUS_CHECK_INTERVAL_MS: 1000,

  // Pending order timeout
  PENDING_TIMEOUT_MS: 60000,  // 1 minute

  // Maximum order modifications
  MAX_MODIFICATIONS: 5,
} as const;

// ============================================================================
// STRATEGY TEMPLATES
// ============================================================================

export const STRATEGY_TEMPLATES = {
  SHORT_STRADDLE: {
    legs: [
      { instrumentType: 'CE' as const, strikeOffset: 0, side: 'SELL' as const, ratio: 1 },
      { instrumentType: 'PE' as const, strikeOffset: 0, side: 'SELL' as const, ratio: 1 },
    ],
  },
  SHORT_STRANGLE: {
    legs: [
      { instrumentType: 'CE' as const, strikeOffset: 100, side: 'SELL' as const, ratio: 1 },
      { instrumentType: 'PE' as const, strikeOffset: -100, side: 'SELL' as const, ratio: 1 },
    ],
  },
  IRON_FLY: {
    legs: [
      { instrumentType: 'CE' as const, strikeOffset: 0, side: 'SELL' as const, ratio: 1 },
      { instrumentType: 'PE' as const, strikeOffset: 0, side: 'SELL' as const, ratio: 1 },
      { instrumentType: 'CE' as const, strikeOffset: 200, side: 'BUY' as const, ratio: 1 },
      { instrumentType: 'PE' as const, strikeOffset: -200, side: 'BUY' as const, ratio: 1 },
    ],
  },
  IRON_CONDOR: {
    legs: [
      { instrumentType: 'CE' as const, strikeOffset: 100, side: 'SELL' as const, ratio: 1 },
      { instrumentType: 'PE' as const, strikeOffset: -100, side: 'SELL' as const, ratio: 1 },
      { instrumentType: 'CE' as const, strikeOffset: 200, side: 'BUY' as const, ratio: 1 },
      { instrumentType: 'PE' as const, strikeOffset: -200, side: 'BUY' as const, ratio: 1 },
    ],
  },
  BULL_CALL_SPREAD: {
    legs: [
      { instrumentType: 'CE' as const, strikeOffset: 0, side: 'BUY' as const, ratio: 1 },
      { instrumentType: 'CE' as const, strikeOffset: 100, side: 'SELL' as const, ratio: 1 },
    ],
  },
  BEAR_PUT_SPREAD: {
    legs: [
      { instrumentType: 'PE' as const, strikeOffset: 0, side: 'BUY' as const, ratio: 1 },
      { instrumentType: 'PE' as const, strikeOffset: -100, side: 'SELL' as const, ratio: 1 },
    ],
  },
} as const;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get lot size for an underlying
 */
export function getLotSize(underlying: Underlying): number {
  return LOT_SIZES[underlying];
}

/**
 * Get strike interval for an underlying
 */
export function getStrikeInterval(underlying: Underlying): number {
  return STRIKE_INTERVALS[underlying];
}

/**
 * Round price to tick size
 */
export function roundToTick(price: Decimal): Decimal {
  return price.dividedBy(TICK_SIZE).round().times(TICK_SIZE);
}

/**
 * Round strike to strike interval
 */
export function roundToStrike(price: number, underlying: Underlying): number {
  const interval = STRIKE_INTERVALS[underlying];
  return Math.round(price / interval) * interval;
}

/**
 * Check if current time is within trading hours
 */
export function isWithinTradingHours(): boolean {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const currentTime = hours * 60 + minutes;

  const [openHour, openMin] = TRADING_HOURS.MARKET_OPEN.split(':').map(Number);
  const [closeHour, closeMin] = TRADING_HOURS.MARKET_CLOSE.split(':').map(Number);

  const openTime = (openHour ?? 9) * 60 + (openMin ?? 15);
  const closeTime = (closeHour ?? 15) * 60 + (closeMin ?? 30);

  return currentTime >= openTime && currentTime <= closeTime;
}

/**
 * Check if today is an expiry day
 */
export function isExpiryDay(expiry: Date): boolean {
  const today = new Date();
  return (
    today.getFullYear() === expiry.getFullYear() &&
    today.getMonth() === expiry.getMonth() &&
    today.getDate() === expiry.getDate()
  );
}

/**
 * Get days to expiry
 */
export function getDaysToExpiry(expiry: Date): number {
  const now = new Date();
  const diff = expiry.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

/**
 * Get time to expiry in years (for BS calculation)
 */
export function getTimeToExpiryYears(expiry: Date): Decimal {
  const now = new Date();
  const diff = expiry.getTime() - now.getTime();
  const years = diff / (1000 * 60 * 60 * 24 * PRICING.DAYS_IN_YEAR);
  return Decimal.max(PRICING.MIN_TIME_TO_EXPIRY, new Decimal(years));
}
