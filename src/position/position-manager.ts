/**
 * Position Manager for NSE Options Paper Trading
 *
 * Manages open positions, handles position updates from trades,
 * calculates P&L in real-time.
 */
// src/position/position-manager.ts

import { persistenceManager } from '../core/persistence.js';
import { getMarginTracker } from '../risk/margin-tracker.js';
import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from '../core/events.js';
import { PositionNotFoundError } from '../core/errors.js';
import { logger, logPosition } from '../utils/logger.js';
import { toDecimal, ZERO, formatINR, weightedAverage } from '../utils/decimal.js';
import { getMarketState } from '../market-data/market-state.js';
import { calculateGreeks } from '../pricing/black-scholes.js';
import { calculateIV } from '../pricing/iv-calculator.js';
import { PRICING } from '../core/constants.js';
import { getTimeToExpiryYears } from '../core/constants.js';
import type {
  Position,
  Trade,
  Order,
  Fill,
  Greeks,
  Underlying,
  InstrumentType,
  PositionSide,
} from '../core/types.js';

// ============================================================================
// POSITION MANAGER
// ============================================================================

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private positionsBySymbol: Map<string, string> = new Map(); // symbol -> positionId
  private trades: Map<string, Trade> = new Map();

  constructor() {
    this.loadState();
  }

  private loadState() {
    const saved = persistenceManager.load();
    if (saved) {
      for (const pos of saved.positions) {
        // Re-map the positions
        this.positions.set(pos.id, pos);
        this.positionsBySymbol.set(pos.symbol, pos.id);
        
        // Re-populate trades if available (optional, depending on your save structure)
        // For now, we just restore positions to resume tracking P&L
      }
      logger.info(`💾 Restored ${this.positions.size} positions from disk`);
    }
  }

  /**
   * Process a filled order and update/create position
   */
  processOrderFill(order: Order): Position {
    if (order.status !== 'FILLED' && order.status !== 'PARTIAL') {
      throw new Error('Order must be filled to process');
    }

    const existingPositionId = this.positionsBySymbol.get(order.symbol);
    const existingPosition = existingPositionId
      ? this.positions.get(existingPositionId)
      : undefined;

    let position: Position;
    let trade: Trade;

    if (existingPosition) {
      // Update existing position
      const result = this.updatePosition(existingPosition, order);
      position = result.position;
      trade = result.trade;

      if (position.quantity === 0) {
        // Position closed
        this.positions.delete(position.id);
        this.positionsBySymbol.delete(position.symbol);

        logPosition('CLOSED', position.id, {
          symbol: position.symbol,
          realizedPnL: formatINR(position.realizedPnL),
        });

        eventBus.emit('POSITION_CLOSED', { ...position, closingTrade: trade });
      } else {
        logPosition('UPDATED', position.id, {
          symbol: position.symbol,
          quantity: position.quantity,
          avgPrice: position.avgPrice.toString(),
        });

        eventBus.emit('POSITION_UPDATED', position);
      }
    } else {
      // Create new position
      const result = this.createPosition(order);
      position = result.position;
      trade = result.trade;

      this.positions.set(position.id, position);
      this.positionsBySymbol.set(position.symbol, position.id);

      logPosition('OPENED', position.id, {
        symbol: position.symbol,
        side: position.side,
        quantity: position.quantity,
        avgPrice: position.avgPrice.toString(),
      });

      eventBus.emit('POSITION_OPENED', position);
    }

    // Store trade
    this.trades.set(trade.id, trade);

    // Auto-save portfolio state after each trade
    try {
        const marginTracker = getMarginTracker();
        const currentCapital = marginTracker.getState().initialCapital;

        persistenceManager.save(
            currentCapital,
            Array.from(this.positions.values())
        );
    } catch (err) {
        logger.error('Failed to auto-save portfolio', { error: err });
    }

    return position;
  }

  /**
   * Create a new position from an order
   */
  private createPosition(order: Order): { position: Position; trade: Trade } {
    const side: PositionSide = order.side === 'BUY' ? 'LONG' : 'SHORT';
    const avgPrice = order.avgFillPrice ?? ZERO;

    const position: Position = {
      id: uuidv4(),
      symbol: order.symbol,
      instrumentToken: order.instrumentToken,
      underlying: order.underlying,
      instrumentType: order.instrumentType,
      strike: order.strike,
      expiry: order.expiry,
      side,
      quantity: order.filledQty,
      avgPrice,
      currentPrice: avgPrice,
      realizedPnL: ZERO,
      unrealizedPnL: ZERO,
      margin: ZERO,
      openedAt: new Date(),
      updatedAt: new Date(),
      trades: [],
    };

    const trade: Trade = {
      id: uuidv4(),
      orderId: order.id,
      positionId: position.id,
      symbol: order.symbol,
      underlying: order.underlying,
      instrumentType: order.instrumentType,
      strike: order.strike,
      expiry: order.expiry,
      side: order.side,
      quantity: order.filledQty,
      price: avgPrice,
      slippage: this.calculateTotalSlippage(order.fills),
      timestamp: new Date(),
      pnlImpact: ZERO,
    };

    position.trades.push(trade.id);

    return { position, trade };
  }

  /**
   * Update an existing position from an order
   */
  private updatePosition(
    position: Position,
    order: Order
  ): { position: Position; trade: Trade } {
    const avgPrice = order.avgFillPrice ?? ZERO;
    const isAddingToPosition =
      (position.side === 'LONG' && order.side === 'BUY') ||
      (position.side === 'SHORT' && order.side === 'SELL');

    let pnlImpact = ZERO;

    if (isAddingToPosition) {
      // Adding to position - average the price
      const newAvgPrice = weightedAverage([
        { value: position.avgPrice, weight: position.quantity },
        { value: avgPrice, weight: order.filledQty },
      ]);

      position.quantity += order.filledQty;
      position.avgPrice = newAvgPrice;
    } else {
      // Reducing or closing position
      const closeQty = Math.min(order.filledQty, position.quantity);
      const remainingQty = Math.max(0, order.filledQty - position.quantity);

      // Calculate realized P&L
      const priceDiff = avgPrice.minus(position.avgPrice);
      const direction = position.side === 'LONG' ? 1 : -1;
      pnlImpact = priceDiff.times(closeQty).times(direction);

      position.realizedPnL = position.realizedPnL.plus(pnlImpact);
      position.quantity -= closeQty;

      // If order quantity exceeds position, flip sides
      if (remainingQty > 0) {
        position.side = position.side === 'LONG' ? 'SHORT' : 'LONG';
        position.quantity = remainingQty;
        position.avgPrice = avgPrice;
        position.realizedPnL = ZERO; // New position starts fresh
      }
    }

    position.updatedAt = new Date();

    const trade: Trade = {
      id: uuidv4(),
      orderId: order.id,
      positionId: position.id,
      symbol: order.symbol,
      underlying: order.underlying,
      instrumentType: order.instrumentType,
      strike: order.strike,
      expiry: order.expiry,
      side: order.side,
      quantity: order.filledQty,
      price: avgPrice,
      slippage: this.calculateTotalSlippage(order.fills),
      timestamp: new Date(),
      pnlImpact,
    };

    position.trades.push(trade.id);

    return { position, trade };
  }

  /**
   * Calculate total slippage from fills
   */
  private calculateTotalSlippage(fills: Fill[]): Decimal {
    return fills.reduce((sum, fill) => sum.plus(fill.slippage), ZERO);
  }

  /**
   * Update all positions with current market prices
   */
  updateMarketPrices(): void {
    const marketState = getMarketState();

    for (const position of this.positions.values()) {
      const state = marketState.getByToken(position.instrumentToken);
      if (!state) continue;

      // Update current price (use mid price for P&L)
      const midPrice = state.bid.plus(state.ask).dividedBy(2);
      position.currentPrice = midPrice.isZero() ? state.ltp : midPrice;

      // Calculate unrealized P&L
      const priceDiff = position.currentPrice.minus(position.avgPrice);
      const direction = position.side === 'LONG' ? 1 : -1;
      position.unrealizedPnL = priceDiff.times(position.quantity).times(direction);

      // Update Greeks if option
      if (position.instrumentType === 'CE' || position.instrumentType === 'PE') {
        const spotPrice = marketState.getSpotPrice(position.underlying);
        if (spotPrice.greaterThan(0)) {
          position.greeks = this.calculatePositionGreeks(position, spotPrice, state.ltp);
        }
      }

      position.updatedAt = new Date();
    }
  }

  /**
   * Calculate Greeks for a position
   */
  private calculatePositionGreeks(
    position: Position,
    spotPrice: Decimal,
    optionPrice: Decimal
  ): Greeks {
    const timeToExpiry = getTimeToExpiryYears(position.expiry);

    // Calculate IV from market price
    let iv: Decimal;
    try {
      iv = calculateIV(
        optionPrice,
        spotPrice,
        toDecimal(position.strike!),
        timeToExpiry,
        PRICING.RISK_FREE_RATE,
        position.instrumentType as 'CE' | 'PE'
      );
    } catch {
      iv = new Decimal(0.20); // Default 20%
    }

    const greeks = calculateGreeks({
      spot: spotPrice,
      strike: toDecimal(position.strike!),
      timeToExpiry,
      riskFreeRate: PRICING.RISK_FREE_RATE,
      volatility: iv,
      optionType: position.instrumentType as 'CE' | 'PE',
    });

    return greeks;
  }

  /**
   * Get position by ID
   */
  getPosition(positionId: string): Position | undefined {
    return this.positions.get(positionId);
  }

  /**
   * Get position by symbol
   */
  getPositionBySymbol(symbol: string): Position | undefined {
    const id = this.positionsBySymbol.get(symbol);
    return id ? this.positions.get(id) : undefined;
  }

  /**
   * Get all open positions
   */
  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get positions for underlying
   */
  getPositionsForUnderlying(underlying: Underlying): Position[] {
    return this.getAllPositions().filter(p => p.underlying === underlying);
  }

  /**
   * Get positions for expiry
   */
  getPositionsForExpiry(expiry: Date): Position[] {
    return this.getAllPositions().filter(
      p => p.expiry.getTime() === expiry.getTime()
    );
  }

  /**
   * Get trade by ID
   */
  getTrade(tradeId: string): Trade | undefined {
    return this.trades.get(tradeId);
  }

  /**
   * Get all trades
   */
  getAllTrades(): Trade[] {
    return Array.from(this.trades.values());
  }

  /**
   * Get trades for position
   */
  getTradesForPosition(positionId: string): Trade[] {
    return this.getAllTrades().filter(t => t.positionId === positionId);
  }

  /**
   * Get aggregate P&L
   */
  getAggregatePnL(): {
    realized: Decimal;
    unrealized: Decimal;
    total: Decimal;
    positionCount: number;
    tradeCount: number;
  } {
    let realized = ZERO;
    let unrealized = ZERO;

    for (const position of this.positions.values()) {
      realized = realized.plus(position.realizedPnL);
      unrealized = unrealized.plus(position.unrealizedPnL);
    }

    return {
      realized,
      unrealized,
      total: realized.plus(unrealized),
      positionCount: this.positions.size,
      tradeCount: this.trades.size,
    };
  }

  /**
   * Get net Greeks across all positions
   */
  getNetGreeks(): {
    delta: Decimal;
    gamma: Decimal;
    theta: Decimal;
    vega: Decimal;
  } {
    let delta = ZERO;
    let gamma = ZERO;
    let theta = ZERO;
    let vega = ZERO;

    for (const position of this.positions.values()) {
      if (!position.greeks) continue;

      const sign = position.side === 'LONG' ? 1 : -1;
      const qty = position.quantity;

      delta = delta.plus(position.greeks.delta.times(qty * sign));
      gamma = gamma.plus(position.greeks.gamma.times(qty * sign));
      theta = theta.plus(position.greeks.theta.times(qty * sign));
      vega = vega.plus(position.greeks.vega.times(qty * sign));
    }

    return { delta, gamma, theta, vega };
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.positions.clear();
    this.positionsBySymbol.clear();
    this.trades.clear();
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let positionManager: PositionManager | null = null;

/**
 * Get PositionManager singleton
 */
export function getPositionManager(): PositionManager {
  if (!positionManager) {
    positionManager = new PositionManager();
  }
  return positionManager;
}

/**
 * Reset PositionManager (for testing)
 */
export function resetPositionManager(): void {
  positionManager?.clear();
  positionManager = null;
}
