/**
 * Custom Error Classes for NSE Options Paper Trading
 *
 * Typed errors for better error handling and debugging.
 */

/**
 * Base class for all trading system errors
 */
export class TradingSystemError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'TradingSystemError';
    this.code = code;
    this.timestamp = new Date();
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      timestamp: this.timestamp,
      context: this.context,
      stack: this.stack,
    };
  }
}

// ============================================================================
// MARKET DATA ERRORS
// ============================================================================

export class MarketDataError extends TradingSystemError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'MARKET_DATA_ERROR', context);
    this.name = 'MarketDataError';
  }
}

export class WebSocketConnectionError extends MarketDataError {
  constructor(reason: string, context?: Record<string, unknown>) {
    super(`WebSocket connection failed: ${reason}`, context);
    this.name = 'WebSocketConnectionError';
  }
}

export class InstrumentNotFoundError extends MarketDataError {
  constructor(symbol: string) {
    super(`Instrument not found: ${symbol}`, { symbol });
    this.name = 'InstrumentNotFoundError';
  }
}

export class MarketDataStaleError extends MarketDataError {
  constructor(symbol: string, lastUpdate: Date) {
    super(`Stale market data for ${symbol}`, { symbol, lastUpdate });
    this.name = 'MarketDataStaleError';
  }
}

// ============================================================================
// ORDER ERRORS
// ============================================================================

export class OrderError extends TradingSystemError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = 'OrderError';
  }
}

export class OrderValidationError extends OrderError {
  constructor(reason: string, context?: Record<string, unknown>) {
    super(`Order validation failed: ${reason}`, 'ORDER_VALIDATION_ERROR', context);
    this.name = 'OrderValidationError';
  }
}

export class OrderRejectedError extends OrderError {
  public readonly orderId: string;
  public readonly rejectionReason: string;

  constructor(orderId: string, reason: string) {
    super(`Order ${orderId} rejected: ${reason}`, 'ORDER_REJECTED', { orderId, reason });
    this.name = 'OrderRejectedError';
    this.orderId = orderId;
    this.rejectionReason = reason;
  }
}

export class OrderNotFoundError extends OrderError {
  constructor(orderId: string) {
    super(`Order not found: ${orderId}`, 'ORDER_NOT_FOUND', { orderId });
    this.name = 'OrderNotFoundError';
  }
}

export class OrderAlreadyFilledError extends OrderError {
  constructor(orderId: string) {
    super(`Order already filled: ${orderId}`, 'ORDER_ALREADY_FILLED', { orderId });
    this.name = 'OrderAlreadyFilledError';
  }
}

export class InsufficientMarginError extends OrderError {
  constructor(required: string, available: string, context?: Record<string, unknown>) {
    super(
      `Insufficient margin: required ${required}, available ${available}`,
      'INSUFFICIENT_MARGIN',
      { required, available, ...context }
    );
    this.name = 'InsufficientMarginError';
  }
}

// ============================================================================
// POSITION ERRORS
// ============================================================================

export class PositionError extends TradingSystemError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = 'PositionError';
  }
}

export class PositionNotFoundError extends PositionError {
  constructor(positionId: string) {
    super(`Position not found: ${positionId}`, 'POSITION_NOT_FOUND', { positionId });
    this.name = 'PositionNotFoundError';
  }
}

export class InvalidPositionStateError extends PositionError {
  constructor(positionId: string, expectedState: string, actualState: string) {
    super(
      `Invalid position state for ${positionId}: expected ${expectedState}, got ${actualState}`,
      'INVALID_POSITION_STATE',
      { positionId, expectedState, actualState }
    );
    this.name = 'InvalidPositionStateError';
  }
}

// ============================================================================
// STRATEGY ERRORS
// ============================================================================

export class StrategyError extends TradingSystemError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = 'StrategyError';
  }
}

export class StrategyNotFoundError extends StrategyError {
  constructor(strategyId: string) {
    super(`Strategy not found: ${strategyId}`, 'STRATEGY_NOT_FOUND', { strategyId });
    this.name = 'StrategyNotFoundError';
  }
}

export class InvalidStrategyError extends StrategyError {
  constructor(reason: string, context?: Record<string, unknown>) {
    super(`Invalid strategy: ${reason}`, 'INVALID_STRATEGY', context);
    this.name = 'InvalidStrategyError';
  }
}

export class StrategyExecutionError extends StrategyError {
  constructor(strategyId: string, reason: string, context?: Record<string, unknown>) {
    super(`Strategy execution failed: ${reason}`, 'STRATEGY_EXECUTION_ERROR', {
      strategyId,
      reason,
      ...context,
    });
    this.name = 'StrategyExecutionError';
  }
}

// ============================================================================
// RISK ERRORS
// ============================================================================

export class RiskError extends TradingSystemError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = 'RiskError';
  }
}

export class MarginBreachError extends RiskError {
  constructor(utilized: string, threshold: string) {
    super(
      `Margin breach: ${utilized}% utilized exceeds ${threshold}% threshold`,
      'MARGIN_BREACH',
      { utilized, threshold }
    );
    this.name = 'MarginBreachError';
  }
}

export class DailyLossLimitError extends RiskError {
  constructor(currentLoss: string, maxLoss: string) {
    super(
      `Daily loss limit reached: ${currentLoss} exceeds limit ${maxLoss}`,
      'DAILY_LOSS_LIMIT',
      { currentLoss, maxLoss }
    );
    this.name = 'DailyLossLimitError';
  }
}

export class KillSwitchActiveError extends RiskError {
  constructor(reason: string) {
    super(`Kill switch is active: ${reason}`, 'KILL_SWITCH_ACTIVE', { reason });
    this.name = 'KillSwitchActiveError';
  }
}

export class PositionLimitError extends RiskError {
  constructor(current: number, max: number) {
    super(
      `Position limit reached: ${current} positions, max ${max}`,
      'POSITION_LIMIT',
      { current, max }
    );
    this.name = 'PositionLimitError';
  }
}

// ============================================================================
// PRICING ERRORS
// ============================================================================

export class PricingError extends TradingSystemError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PRICING_ERROR', context);
    this.name = 'PricingError';
  }
}

export class IVCalculationError extends PricingError {
  constructor(symbol: string, reason: string) {
    super(`IV calculation failed for ${symbol}: ${reason}`, { symbol, reason });
    this.name = 'IVCalculationError';
  }
}

export class GreeksCalculationError extends PricingError {
  constructor(symbol: string, reason: string) {
    super(`Greeks calculation failed for ${symbol}: ${reason}`, { symbol, reason });
    this.name = 'GreeksCalculationError';
  }
}

// ============================================================================
// EXECUTION ERRORS
// ============================================================================

export class ExecutionError extends TradingSystemError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = 'ExecutionError';
  }
}

export class FillError extends ExecutionError {
  constructor(orderId: string, reason: string) {
    super(`Fill failed for order ${orderId}: ${reason}`, 'FILL_ERROR', { orderId, reason });
    this.name = 'FillError';
  }
}

export class SlippageExcessiveError extends ExecutionError {
  constructor(orderId: string, slippage: string, maxAllowed: string) {
    super(
      `Excessive slippage for order ${orderId}: ${slippage} exceeds ${maxAllowed}`,
      'EXCESSIVE_SLIPPAGE',
      { orderId, slippage, maxAllowed }
    );
    this.name = 'SlippageExcessiveError';
  }
}

// ============================================================================
// PERSISTENCE ERRORS
// ============================================================================

export class PersistenceError extends TradingSystemError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PERSISTENCE_ERROR', context);
    this.name = 'PersistenceError';
  }
}

export class DatabaseError extends PersistenceError {
  constructor(operation: string, reason: string) {
    super(`Database ${operation} failed: ${reason}`, { operation, reason });
    this.name = 'DatabaseError';
  }
}

// ============================================================================
// CONFIGURATION ERRORS
// ============================================================================

export class ConfigurationError extends TradingSystemError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', context);
    this.name = 'ConfigurationError';
  }
}

export class MissingConfigError extends ConfigurationError {
  constructor(key: string) {
    super(`Missing required configuration: ${key}`, { key });
    this.name = 'MissingConfigError';
  }
}

export class InvalidConfigError extends ConfigurationError {
  constructor(key: string, value: unknown, reason: string) {
    super(`Invalid configuration for ${key}: ${reason}`, { key, value, reason });
    this.name = 'InvalidConfigError';
  }
}

// ============================================================================
// API ERRORS
// ============================================================================

export class ApiError extends TradingSystemError {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number, context?: Record<string, unknown>) {
    super(message, 'API_ERROR', context);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

export class AuthenticationError extends ApiError {
  constructor(reason: string) {
    super(`Authentication failed: ${reason}`, 401, { reason });
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends ApiError {
  constructor(retryAfter?: number) {
    super('Rate limit exceeded', 429, { retryAfter });
    this.name = 'RateLimitError';
  }
}

// ============================================================================
// ERROR UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if an error is a trading system error
 */
export function isTradingSystemError(error: unknown): error is TradingSystemError {
  return error instanceof TradingSystemError;
}

/**
 * Wrap unknown errors in TradingSystemError
 */
export function wrapError(error: unknown, defaultMessage = 'Unknown error'): TradingSystemError {
  if (isTradingSystemError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new TradingSystemError(error.message, 'WRAPPED_ERROR', {
      originalName: error.name,
      originalStack: error.stack,
    });
  }

  return new TradingSystemError(defaultMessage, 'UNKNOWN_ERROR', {
    originalError: String(error),
  });
}

/**
 * Create error handler that logs and optionally rethrows
 */
export function createErrorHandler(
  logger: (error: TradingSystemError) => void,
  rethrow = true
): (error: unknown) => void {
  return (error: unknown) => {
    const wrappedError = wrapError(error);
    logger(wrappedError);
    if (rethrow) {
      throw wrappedError;
    }
  };
}
