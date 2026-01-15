/**
 * Fill Engine for NSE Options Paper Trading
 *
 * Simulates order execution with realistic fills.
 * Handles market orders, limit orders, and partial fills.
 */

import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;
import { v4 as uuidv4 } from 'uuid';
import { LATENCY, ORDERS, TICK_SIZE } from '../core/constants.js';
import { eventBus } from '../core/events.js';
import { OrderRejectedError, FillError } from '../core/errors.js';
import { logger, logOrder, logTrade } from '../utils/logger.js';
import { toDecimal, ZERO, roundToTick } from '../utils/decimal.js';
import { getMarketState } from '../market-data/market-state.js';
import { getSpotTracker } from '../market-data/spot-tracker.js';
import {
  calculateSlippage,
  calculateFillPrice,
  calculateDepthFills,
  calculateAverageFillPrice,
  slippageAnalyzer,
} from './slippage.js';
import { simulateLatency, getRandomLatency } from './latency.js';
import type {
  Order,
  OrderRequest,
  Fill,
  FillResult,
  Trade,
  InstrumentState,
  SlippageParams,
} from '../core/types.js';

// ============================================================================
// FILL ENGINE
// ============================================================================

export class FillEngine {
  private pendingOrders: Map<string, Order> = new Map();
  private fillCheckInterval?: NodeJS.Timeout;

  constructor() {
    // Start fill check loop
    this.startFillLoop();
  }

  /**
   * Submit a new order for execution
   */
  async submitOrder(request: OrderRequest): Promise<Order> {
    const marketState = getMarketState();
    const instrumentState = marketState.getBySymbol(request.symbol);

    // Validate we have market data
    if (!instrumentState) {
      throw new OrderRejectedError(
        uuidv4(),
        `No market data for ${request.symbol}`
      );
    }

    // Create order
    const order: Order = {
      id: uuidv4(),
      strategyId: request.strategyId,
      symbol: request.symbol,
      instrumentToken: instrumentState.instrumentToken,
      underlying: request.underlying,
      instrumentType: request.instrumentType,
      strike: request.strike,
      expiry: request.expiry,
      side: request.side,
      quantity: request.quantity,
      orderType: request.orderType,
      limitPrice: request.limitPrice,
      triggerPrice: request.triggerPrice,
      status: 'PENDING',
      filledQty: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fills: [],
      tag: request.tag,
    };

    logOrder('CREATED', order.id, {
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
    });

    eventBus.emit('ORDER_CREATED', order);

    // Add latency before processing
    const latency = getRandomLatency();
    await simulateLatency(latency);

    // For MARKET orders, execute immediately
    if (order.orderType === 'MARKET') {
      return this.executeMarketOrder(order, instrumentState, latency);
    }

    // For LIMIT orders, add to pending queue
    order.status = 'OPEN';
    order.updatedAt = new Date();
    this.pendingOrders.set(order.id, order);

    return order;
  }

  /**
   * Execute a market order immediately
   */
  private async executeMarketOrder(
    order: Order,
    instrumentState: InstrumentState,
    latency: number
  ): Promise<Order> {
    const spotTracker = getSpotTracker();
    const marketState = getMarketState();

    // Get current IV
    const currentIV = instrumentState.iv ?? toDecimal(20);

    // Calculate slippage
    const slippageParams: SlippageParams = {
      orderSide: order.side,
      quantity: order.quantity,
      currentBid: instrumentState.bid,
      currentAsk: instrumentState.ask,
      spotVelocity: spotTracker.getVelocity(order.underlying),
      currentIV,
      avgDailyVolume: instrumentState.volume,
      depth: instrumentState.depth,
      underlying: order.underlying,
      instrumentType: order.instrumentType,
      daysToExpiry: order.expiry
        ? Math.ceil((order.expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : 30,
    };

    const slippageResult = calculateSlippage(slippageParams);

    // Calculate fill price
    let fillPrice: Decimal;
    let fills: Fill[];

    if (instrumentState.depth) {
      // Use depth-aware fill calculation
      const depthFills = calculateDepthFills(
        order.side,
        order.quantity,
        instrumentState.depth,
        slippageResult.totalSlippage
      );
      fillPrice = calculateAverageFillPrice(depthFills);

      // Convert to Fill objects
      fills = depthFills.map(df => ({
        id: uuidv4(),
        orderId: order.id,
        price: df.price,
        quantity: df.quantity,
        slippage: slippageResult.totalSlippage.dividedBy(depthFills.length),
        latencyMs: latency,
        timestamp: new Date(),
      }));
    } else {
      // Simple fill
      fillPrice = calculateFillPrice(
        order.side,
        instrumentState.bid,
        instrumentState.ask,
        slippageResult.totalSlippage
      );

      fills = [{
        id: uuidv4(),
        orderId: order.id,
        price: fillPrice,
        quantity: order.quantity,
        slippage: slippageResult.totalSlippage,
        latencyMs: latency,
        timestamp: new Date(),
      }];
    }

    // Update order
    order.status = 'FILLED';
    order.filledQty = order.quantity;
    order.avgFillPrice = fillPrice;
    order.updatedAt = new Date();
    order.fills = fills;

    logOrder('FILLED', order.id, {
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      avgPrice: fillPrice.toString(),
      slippage: slippageResult.totalSlippage.toString(),
      latencyMs: latency,
    });

    eventBus.emit('ORDER_FILLED', order);

    // Record slippage for analytics
    slippageAnalyzer.addRecord({
      timestamp: new Date(),
      symbol: order.symbol,
      side: order.side,
      expectedSlippage: slippageResult.totalSlippage,
      actualSlippage: slippageResult.totalSlippage, // In simulation, these are same
      components: slippageResult.components,
      spotVelocity: slippageParams.spotVelocity,
      iv: currentIV,
      quantity: order.quantity,
    });

    return order;
  }

  /**
   * Check if a limit order can be filled
   */
  private checkLimitOrderFill(order: Order, instrumentState: InstrumentState): FillResult | null {
    const spotTracker = getSpotTracker();

    if (!order.limitPrice) {
      return null;
    }

    // Get current IV
    const currentIV = instrumentState.iv ?? toDecimal(20);

    // Calculate slippage
    const slippageParams: SlippageParams = {
      orderSide: order.side,
      quantity: order.quantity - order.filledQty,
      currentBid: instrumentState.bid,
      currentAsk: instrumentState.ask,
      spotVelocity: spotTracker.getVelocity(order.underlying),
      currentIV,
      avgDailyVolume: instrumentState.volume,
      depth: instrumentState.depth,
      underlying: order.underlying,
      instrumentType: order.instrumentType,
      daysToExpiry: order.expiry
        ? Math.ceil((order.expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : 30,
    };

    const slippageResult = calculateSlippage(slippageParams);
    const potentialFillPrice = calculateFillPrice(
      order.side,
      instrumentState.bid,
      instrumentState.ask,
      slippageResult.totalSlippage
    );

    // Check if limit price is met
    if (order.side === 'BUY') {
      // BUY limit: fill only if market price <= limit
      if (potentialFillPrice.greaterThan(order.limitPrice)) {
        return null;
      }
    } else {
      // SELL limit: fill only if market price >= limit
      if (potentialFillPrice.lessThan(order.limitPrice)) {
        return null;
      }
    }

    // Can fill!
    return {
      filled: true,
      fillPrice: potentialFillPrice,
      fillQty: order.quantity - order.filledQty,
      partialFill: false,
      slippageApplied: slippageResult.totalSlippage,
      slippageComponents: slippageResult.components,
      latencyMs: getRandomLatency(),
      timestamp: new Date(),
    };
  }

  /**
   * Start the fill check loop for limit orders
   */
  private startFillLoop(): void {
    this.fillCheckInterval = setInterval(() => {
      this.checkPendingOrders();
    }, ORDERS.STATUS_CHECK_INTERVAL_MS);
  }

  /**
   * Check all pending orders for fills
   */
  private checkPendingOrders(): void {
    const marketState = getMarketState();
    const now = Date.now();

    for (const [orderId, order] of this.pendingOrders) {
      // Check for timeout
      if (now - order.createdAt.getTime() > ORDERS.PENDING_TIMEOUT_MS) {
        order.status = 'CANCELLED';
        order.rejectionReason = 'Order timeout';
        order.updatedAt = new Date();
        this.pendingOrders.delete(orderId);

        logOrder('CANCELLED', orderId, { reason: 'timeout' });
        eventBus.emit('ORDER_CANCELLED', order);
        continue;
      }

      // Get current market state
      const instrumentState = marketState.getByToken(order.instrumentToken);
      if (!instrumentState) continue;

      // Check for fill
      const fillResult = this.checkLimitOrderFill(order, instrumentState);

      if (fillResult?.filled) {
        // Create fill record
        const fill: Fill = {
          id: uuidv4(),
          orderId: order.id,
          price: fillResult.fillPrice,
          quantity: fillResult.fillQty,
          slippage: fillResult.slippageApplied,
          latencyMs: fillResult.latencyMs,
          timestamp: fillResult.timestamp,
        };

        // Update order
        order.fills.push(fill);
        order.filledQty += fillResult.fillQty;
        order.avgFillPrice = this.calculateAvgFillPrice(order.fills);
        order.updatedAt = new Date();

        if (order.filledQty >= order.quantity) {
          order.status = 'FILLED';
          this.pendingOrders.delete(orderId);

          logOrder('FILLED', orderId, {
            symbol: order.symbol,
            side: order.side,
            quantity: order.filledQty,
            avgPrice: order.avgFillPrice?.toString(),
          });

          eventBus.emit('ORDER_FILLED', order);
        } else {
          order.status = 'PARTIAL';

          logOrder('PARTIAL', orderId, {
            filled: order.filledQty,
            remaining: order.quantity - order.filledQty,
          });

          eventBus.emit('ORDER_PARTIAL', order);
        }
      }
    }
  }

  /**
   * Calculate average fill price from multiple fills
   */
  private calculateAvgFillPrice(fills: Fill[]): Decimal {
    if (fills.length === 0) return ZERO;

    let totalValue = ZERO;
    let totalQty = 0;

    for (const fill of fills) {
      totalValue = totalValue.plus(fill.price.times(fill.quantity));
      totalQty += fill.quantity;
    }

    if (totalQty === 0) return ZERO;
    return roundToTick(totalValue.dividedBy(totalQty));
  }

  /**
   * Cancel an order
   */
  cancelOrder(orderId: string): Order | null {
    const order = this.pendingOrders.get(orderId);
    if (!order) return null;

    order.status = 'CANCELLED';
    order.rejectionReason = 'User cancelled';
    order.updatedAt = new Date();
    this.pendingOrders.delete(orderId);

    logOrder('CANCELLED', orderId, { reason: 'user' });
    eventBus.emit('ORDER_CANCELLED', order);

    return order;
  }

  /**
   * Get pending orders
   */
  getPendingOrders(): Order[] {
    return Array.from(this.pendingOrders.values());
  }

  /**
   * Get pending order by ID
   */
  getPendingOrder(orderId: string): Order | undefined {
    return this.pendingOrders.get(orderId);
  }

  /**
   * Stop the fill engine
   */
  stop(): void {
    if (this.fillCheckInterval) {
      clearInterval(this.fillCheckInterval);
    }
  }

  /**
   * Clear all pending orders
   */
  clear(): void {
    for (const [orderId, order] of this.pendingOrders) {
      order.status = 'CANCELLED';
      order.rejectionReason = 'Engine stopped';
      order.updatedAt = new Date();
      eventBus.emit('ORDER_CANCELLED', order);
    }
    this.pendingOrders.clear();
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let fillEngine: FillEngine | null = null;

/**
 * Get FillEngine singleton
 */
export function getFillEngine(): FillEngine {
  if (!fillEngine) {
    fillEngine = new FillEngine();
  }
  return fillEngine;
}

/**
 * Reset FillEngine (for testing)
 */
export function resetFillEngine(): void {
  fillEngine?.stop();
  fillEngine?.clear();
  fillEngine = null;
}
