/**
 * Core Type Definitions for NSE Options Paper Trading System
 *
 * IMPORTANT: All monetary values use Decimal.js for precision.
 * Never use native JavaScript numbers for prices, P&L, or margin calculations.
 */

import { Decimal } from '../utils/decimal.js';

// ============================================================================
// ENUMS
// ============================================================================

export type Underlying = 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY';
export type InstrumentType = 'SPOT' | 'FUT' | 'CE' | 'PE';
export type OrderSide = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED';
export type StrategyType = 'SHORT_STRADDLE' | 'SHORT_STRANGLE' | 'IRON_FLY' | 'IRON_CONDOR' | 'LONG_STRADDLE' | 'LONG_STRANGLE' | 'BULL_CALL_SPREAD' | 'BEAR_PUT_SPREAD' | 'CUSTOM';
export type StrategyStatus = 'OPEN' | 'CLOSED' | 'PARTIAL';
export type SpotDirection = 'UP' | 'DOWN' | 'FLAT';
export type KillSwitchReason = 'DAILY_LOSS_LIMIT' | 'MARGIN_BREACH' | 'MANUAL' | 'ERROR';

// ============================================================================
// MARKET DATA TYPES
// ============================================================================

/**
 * Order book depth level
 */
export interface DepthLevel {
  price: Decimal;
  quantity: number;
  orders: number;
}

/**
 * Full order book depth (top 5 levels)
 */
export interface OrderBookDepth {
  buy: DepthLevel[];   // Bids (sorted high to low)
  sell: DepthLevel[];  // Asks (sorted low to high)
}

/**
 * Normalized market tick from Zerodha WebSocket
 */
export interface MarketTick {
  instrumentToken: number;
  tradingSymbol: string;
  underlying: Underlying;
  instrumentType: InstrumentType;
  strike?: number;
  expiry?: Date;
  ltp: Decimal;
  bid: Decimal;
  ask: Decimal;
  bidQty: number;
  askQty: number;
  volume: number;
  oi: number;
  oiDayHigh: number;
  oiDayLow: number;
  lastTradeTime: Date;
  timestamp: Date;
  depth?: OrderBookDepth;
}

/**
 * Spot price movement tracking for velocity calculations
 */
export interface SpotMovement {
  underlying: Underlying;
  current: Decimal;
  previous: Decimal;
  velocity: Decimal;        // Points per second
  acceleration: Decimal;    // Change in velocity
  direction: SpotDirection;
  timestamp: Date;
  samples: SpotSample[];    // Rolling window for velocity calc
}

export interface SpotSample {
  price: Decimal;
  timestamp: Date;
}

/**
 * Market state for a single instrument
 */
export interface InstrumentState {
  instrumentToken: number;
  tradingSymbol: string;
  underlying: Underlying;
  instrumentType: InstrumentType;
  strike?: number;
  expiry?: Date;
  ltp: Decimal;
  bid: Decimal;
  ask: Decimal;
  bidQty: number;
  askQty: number;
  volume: number;
  oi: number;
  lastUpdate: Date;
  depth?: OrderBookDepth;
  // Computed fields
  iv?: Decimal;
  greeks?: Greeks;
}

// ============================================================================
// OPTIONS PRICING TYPES
// ============================================================================

/**
 * Greeks for an option
 */
export interface Greeks {
  delta: Decimal;
  gamma: Decimal;
  theta: Decimal;     // Daily theta (in rupees)
  vega: Decimal;      // Per 1% IV change
  rho: Decimal;
  iv: Decimal;        // Implied volatility (as percentage, e.g., 15 = 15%)
}

/**
 * Parameters for Black-Scholes calculation
 */
export interface BSParams {
  spot: Decimal;
  strike: Decimal;
  timeToExpiry: Decimal;    // In years
  riskFreeRate: Decimal;    // As decimal, e.g., 0.07 for 7%
  volatility: Decimal;      // As decimal, e.g., 0.15 for 15%
  optionType: 'CE' | 'PE';
}

/**
 * IV inflation parameters for seller pain modeling
 */
export interface IVInflationParams {
  baseIV: Decimal;
  spotVelocity: Decimal;
  spotAcceleration: Decimal;
  timeToExpiry: number;       // Days
  moneyness: Decimal;         // Strike/Spot ratio
  direction: SpotDirection;
}

// ============================================================================
// ORDER TYPES
// ============================================================================

/**
 * Order fill record
 */
export interface Fill {
  id: string;
  orderId: string;
  price: Decimal;
  quantity: number;
  slippage: Decimal;
  latencyMs: number;
  timestamp: Date;
}

/**
 * Trading order
 */
export interface Order {
  id: string;
  strategyId?: string;
  symbol: string;
  instrumentToken: number;
  underlying: Underlying;
  instrumentType: InstrumentType;
  strike?: number;
  expiry: Date;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice?: Decimal;
  triggerPrice?: Decimal;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice?: Decimal;
  createdAt: Date;
  updatedAt: Date;
  fills: Fill[];
  rejectionReason?: string;
  tag?: string;
}

/**
 * Order creation request
 */
export interface OrderRequest {
  symbol: string;
  underlying: Underlying;
  instrumentType: InstrumentType;
  strike?: number;
  expiry: Date;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice?: Decimal;
  triggerPrice?: Decimal;
  strategyId?: string;
  tag?: string;
}

// ============================================================================
// EXECUTION TYPES
// ============================================================================

/**
 * Slippage calculation parameters
 */
export interface SlippageParams {
  orderSide: OrderSide;
  quantity: number;
  currentBid: Decimal;
  currentAsk: Decimal;
  spotVelocity: Decimal;
  currentIV: Decimal;
  avgDailyVolume: number;
  depth?: OrderBookDepth;
  underlying: Underlying;
  instrumentType: InstrumentType;
  daysToExpiry: number;
}

/**
 * Slippage calculation result
 */
export interface SlippageResult {
  totalSlippage: Decimal;
  components: {
    base: Decimal;
    spread: Decimal;
    velocity: Decimal;
    iv: Decimal;
    size: Decimal;
    depth: Decimal;
  };
}

/**
 * Fill execution result
 */
export interface FillResult {
  filled: boolean;
  fillPrice: Decimal;
  fillQty: number;
  partialFill: boolean;
  slippageApplied: Decimal;
  slippageComponents: SlippageResult['components'];
  latencyMs: number;
  timestamp: Date;
  reason?: string;
}

// ============================================================================
// POSITION TYPES
// ============================================================================

/**
 * Trading position
 */
export interface Position {
  id: string;
  symbol: string;
  instrumentToken: number;
  underlying: Underlying;
  instrumentType: InstrumentType;
  strike?: number;
  expiry: Date;
  side: PositionSide;
  quantity: number;
  avgPrice: Decimal;
  currentPrice: Decimal;
  realizedPnL: Decimal;
  unrealizedPnL: Decimal;
  margin: Decimal;
  greeks?: Greeks;
  openedAt: Date;
  updatedAt: Date;
  trades: string[];    // Trade IDs
}

/**
 * Trade execution record
 */
export interface Trade {
  id: string;
  orderId: string;
  positionId: string;
  symbol: string;
  underlying: Underlying;
  instrumentType: InstrumentType;
  strike?: number;
  expiry: Date;
  side: OrderSide;
  quantity: number;
  price: Decimal;
  slippage: Decimal;
  timestamp: Date;
  pnlImpact: Decimal;    // For closing trades
}

// ============================================================================
// STRATEGY TYPES
// ============================================================================

/**
 * Strategy leg definition
 */
export interface StrategyLeg {
  instrumentType: 'CE' | 'PE';
  strikeOffset: number;     // Offset from ATM (e.g., 0 for ATM, 100 for 100 points OTM)
  side: OrderSide;
  ratio: number;            // Multiplier (usually 1)
  positionId?: string;
}

/**
 * Multi-leg strategy
 */
export interface Strategy {
  id: string;
  name: string;
  type: StrategyType;
  underlying: Underlying;
  expiry: Date;
  atmStrike: number;
  legs: StrategyLeg[];
  positions: string[];      // Position IDs
  status: StrategyStatus;
  entryTime: Date;
  exitTime?: Date;
  realizedPnL: Decimal;
  unrealizedPnL: Decimal;
  totalPnL: Decimal;
  maxProfit?: Decimal;
  maxLoss?: Decimal;
  breakevens: Decimal[];
  margin: Decimal;
  lotSize: number;
  lots: number;
}

/**
 * Strategy P&L breakdown
 */
export interface StrategyPnL {
  strategyId: string;
  realized: Decimal;
  unrealized: Decimal;
  total: Decimal;
  legs: Array<{
    symbol: string;
    side: PositionSide;
    realized: Decimal;
    unrealized: Decimal;
  }>;
}

// ============================================================================
// RISK & MARGIN TYPES
// ============================================================================

/**
 * Margin calculation result
 */
export interface MarginCalculation {
  spanMargin: Decimal;
  exposureMargin: Decimal;
  totalMargin: Decimal;
  premiumReceived: Decimal;
  premiumPaid: Decimal;
  netMargin: Decimal;
}

/**
 * Account margin state
 */
export interface MarginState {
  initialCapital: Decimal;
  availableMargin: Decimal;
  usedMargin: Decimal;
  marginUtilization: Decimal;    // Percentage
  pendingOrderMargin: Decimal;
  mtmPnL: Decimal;
  realizedPnL: Decimal;
  netLiquidation: Decimal;       // Capital + MTM
}

/**
 * Kill switch event
 */
export interface KillSwitchEvent {
  triggered: boolean;
  reason?: KillSwitchReason;
  timestamp?: Date;
  dailyPnL: Decimal;
  marginUtilization: Decimal;
  message?: string;
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

/**
 * Zerodha API configuration
 */
export interface ZerodhaConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  userId: string;
}

/**
 * Trading configuration
 */
export interface TradingConfig {
  underlyings: Underlying[];
  strikesAroundATM: number;
  expiryWeeks: number;
  tradingStartTime: string;    // HH:mm format
  tradingEndTime: string;      // HH:mm format
}

/**
 * Execution simulation configuration
 */
export interface ExecutionConfig {
  latencyMinMs: number;
  latencyMaxMs: number;
  baseSlippage: number;
  velocitySlippageMultiplier: number;
  ivSlippageMultiplier: number;
  sizeSlippageMultiplier: number;
  depthSlippageMultiplier: number;
}

/**
 * Risk configuration
 */
export interface RiskConfig {
  initialCapital: number;
  maxDailyLoss: number;
  maxDailyLossPct: number;
  marginBreachThreshold: number;
  forceExitOnBreach: boolean;
  expiryDayMarginMultiplier: number;
}

/**
 * Database configuration
 */
export interface DatabaseConfig {
  path: string;
  backupEnabled: boolean;
  backupIntervalMinutes: number;
}

/**
 * Webhook configuration
 */
export interface WebhookConfig {
  enabled: boolean;
  port: number;
  secret: string;
  allowedIPs: string[];
}

/**
 * Full system configuration
 */
export interface SystemConfig {
  zerodha: ZerodhaConfig;
  trading: TradingConfig;
  execution: ExecutionConfig;
  risk: RiskConfig;
  database: DatabaseConfig;
  webhook: WebhookConfig;
}

// ============================================================================
// INSTRUMENT TYPES
// ============================================================================

/**
 * Instrument master record
 */
export interface Instrument {
  instrumentToken: number;
  exchangeToken: number;
  tradingSymbol: string;
  name: string;
  exchange: string;
  segment: string;
  instrumentType: string;
  strike?: number;
  expiry?: Date;
  lotSize: number;
  tickSize: number;
  underlying?: Underlying;
}

/**
 * Option chain for an underlying
 */
export interface OptionChain {
  underlying: Underlying;
  spotPrice: Decimal;
  expiries: Date[];
  strikes: Map<number, {
    ce?: InstrumentState;
    pe?: InstrumentState;
  }>;
}

// ============================================================================
// EVENT TYPES
// ============================================================================

export type SystemEventType =
  | 'TICK'
  | 'ORDER_CREATED'
  | 'ORDER_FILLED'
  | 'ORDER_PARTIAL'
  | 'ORDER_CANCELLED'
  | 'ORDER_REJECTED'
  | 'POSITION_OPENED'
  | 'POSITION_UPDATED'
  | 'POSITION_CLOSED'
  | 'STRATEGY_CREATED'
  | 'STRATEGY_UPDATED'
  | 'STRATEGY_CLOSED'
  | 'MARGIN_WARNING'
  | 'MARGIN_BREACH'
  | 'KILL_SWITCH_TRIGGERED'
  | 'WEBSOCKET_CONNECTED'
  | 'WEBSOCKET_DISCONNECTED'
  | 'WEBSOCKET_ERROR'
  | 'DAILY_RESET';

export interface SystemEvent<T = unknown> {
  type: SystemEventType;
  payload: T;
  timestamp: Date;
}

// ============================================================================
// API TYPES
// ============================================================================

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: Date;
}

/**
 * TradingView webhook payload
 */
export interface TradingViewAlert {
  action: 'BUY' | 'SELL' | 'CLOSE';
  symbol: string;
  underlying?: Underlying;
  instrumentType?: InstrumentType;
  strike?: number;
  expiry?: string;
  quantity?: number;
  orderType?: OrderType;
  limitPrice?: number;
  strategyId?: string;
  message?: string;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/**
 * Partial update for Position
 */
export type PositionUpdate = Partial<Omit<Position, 'id' | 'symbol' | 'instrumentToken'>>;

/**
 * Partial update for Order
 */
export type OrderUpdate = Partial<Omit<Order, 'id' | 'symbol' | 'instrumentToken'>>;

/**
 * Decimal-aware JSON serialization
 */
export interface SerializableDecimal {
  type: 'Decimal';
  value: string;
}

/**
 * Day summary for reporting
 */
export interface DaySummary {
  date: Date;
  startingCapital: Decimal;
  endingCapital: Decimal;
  realizedPnL: Decimal;
  unrealizedPnL: Decimal;
  totalPnL: Decimal;
  tradesCount: number;
  winningTrades: number;
  losingTrades: number;
  maxDrawdown: Decimal;
  maxProfit: Decimal;
  peakCapital: Decimal;
  troughCapital: Decimal;
  marginUtilizationPeak: Decimal;
  killSwitchTriggered: boolean;
}
