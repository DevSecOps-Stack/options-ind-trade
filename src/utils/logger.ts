/**
 * Logging Configuration for NSE Options Paper Trading
 *
 * Uses Winston for structured logging with file rotation.
 */

import winston from 'winston';
import { LOGGING } from '../core/constants.js';
import type { TradingSystemError } from '../core/errors.js';

// ============================================================================
// LOG FORMATS
// ============================================================================

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.json()
);

// ============================================================================
// LOGGER INSTANCE
// ============================================================================

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? LOGGING.DEFAULT_LEVEL,
  defaultMeta: { service: 'options-paper-trading' },
  transports: [
    // Console transport (always enabled)
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

// Add file transports in non-test environments
if (process.env['NODE_ENV'] !== 'test') {
  logger.add(
    new winston.transports.File({
      filename: `${LOGGING.LOG_DIR}error.log`,
      level: 'error',
      format: fileFormat,
      maxsize: parseInt(LOGGING.FILE_MAX_SIZE),
      maxFiles: LOGGING.FILE_MAX_FILES,
    })
  );

  logger.add(
    new winston.transports.File({
      filename: `${LOGGING.LOG_DIR}combined.log`,
      format: fileFormat,
      maxsize: parseInt(LOGGING.FILE_MAX_SIZE),
      maxFiles: LOGGING.FILE_MAX_FILES,
    })
  );

  // Trading activity log (orders, trades, positions)
  logger.add(
    new winston.transports.File({
      filename: `${LOGGING.LOG_DIR}trading.log`,
      format: fileFormat,
      maxsize: parseInt(LOGGING.FILE_MAX_SIZE),
      maxFiles: LOGGING.FILE_MAX_FILES,
    })
  );
}

// ============================================================================
// SPECIALIZED LOGGERS
// ============================================================================

/**
 * Market data logger - for tick and depth logging
 */
export const marketDataLogger = logger.child({ component: 'market-data' });

/**
 * Execution logger - for order and trade logging
 */
export const executionLogger = logger.child({ component: 'execution' });

/**
 * Risk logger - for margin and kill switch logging
 */
export const riskLogger = logger.child({ component: 'risk' });

/**
 * Position logger - for position and P&L logging
 */
export const positionLogger = logger.child({ component: 'position' });

/**
 * Strategy logger - for strategy execution logging
 */
export const strategyLogger = logger.child({ component: 'strategy' });

/**
 * API logger - for webhook and API logging
 */
export const apiLogger = logger.child({ component: 'api' });

// ============================================================================
// LOGGING UTILITIES
// ============================================================================

/**
 * Log a trading system error with full context
 */
export function logError(error: TradingSystemError): void {
  logger.error(error.message, {
    code: error.code,
    context: error.context,
    stack: error.stack,
  });
}

/**
 * Log order activity
 */
export function logOrder(
  action: 'CREATED' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED',
  orderId: string,
  details: Record<string, unknown>
): void {
  executionLogger.info(`Order ${action}`, {
    orderId,
    action,
    ...details,
  });
}

/**
 * Log trade execution
 */
export function logTrade(
  tradeId: string,
  orderId: string,
  details: Record<string, unknown>
): void {
  executionLogger.info('Trade executed', {
    tradeId,
    orderId,
    ...details,
  });
}

/**
 * Log position change
 */
export function logPosition(
  action: 'OPENED' | 'UPDATED' | 'CLOSED',
  positionId: string,
  details: Record<string, unknown>
): void {
  positionLogger.info(`Position ${action}`, {
    positionId,
    action,
    ...details,
  });
}

/**
 * Log risk event
 */
export function logRiskEvent(
  event: 'MARGIN_WARNING' | 'MARGIN_BREACH' | 'KILL_SWITCH',
  details: Record<string, unknown>
): void {
  const level = event === 'MARGIN_WARNING' ? 'warn' : 'error';
  riskLogger.log(level, `Risk event: ${event}`, details);
}

/**
 * Log market data event
 */
export function logMarketData(
  event: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'ERROR',
  details?: Record<string, unknown>
): void {
  const level = event === 'ERROR' ? 'error' : 'info';
  marketDataLogger.log(level, `WebSocket ${event}`, details);
}

/**
 * Create a performance timer
 */
export function createTimer(operation: string): () => void {
  const start = performance.now();
  return () => {
    const duration = performance.now() - start;
    logger.debug(`${operation} completed`, { durationMs: duration.toFixed(2) });
  };
}

/**
 * Log with rate limiting (to avoid log spam)
 */
const rateLimitCache = new Map<string, number>();

export function logRateLimited(
  key: string,
  intervalMs: number,
  logFn: () => void
): void {
  const now = Date.now();
  const lastLog = rateLimitCache.get(key) ?? 0;

  if (now - lastLog >= intervalMs) {
    rateLimitCache.set(key, now);
    logFn();
  }
}

// ============================================================================
// LOG LEVEL CONTROL
// ============================================================================

/**
 * Set log level at runtime
 */
export function setLogLevel(level: string): void {
  logger.level = level;
  logger.info(`Log level set to ${level}`);
}

/**
 * Get current log level
 */
export function getLogLevel(): string {
  return logger.level;
}

/**
 * Enable debug logging temporarily
 */
export function enableDebug(): () => void {
  const previousLevel = logger.level;
  logger.level = 'debug';
  logger.debug('Debug logging enabled');

  return () => {
    logger.debug('Debug logging disabled');
    logger.level = previousLevel;
  };
}
