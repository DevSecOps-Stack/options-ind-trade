/**
 * Strategy Aggregator for NSE Options Paper Trading
 *
 * Groups positions into multi-leg strategies and calculates
 * strategy-level P&L and risk metrics.
 */

import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { STRATEGY_TEMPLATES, LOT_SIZES, getStrikeInterval } from '../core/constants.js';
import { eventBus } from '../core/events.js';
import { InvalidStrategyError, StrategyNotFoundError } from '../core/errors.js';
import { logger, strategyLogger } from '../utils/logger.js';
import { toDecimal, ZERO, formatINR } from '../utils/decimal.js';
import { getMarketState } from '../market-data/market-state.js';
import { getPositionManager } from './position-manager.js';
import type {
  Strategy,
  StrategyType,
  StrategyLeg,
  StrategyPnL,
  Position,
  Underlying,
  OrderRequest,
} from '../core/types.js';

// ============================================================================
// STRATEGY AGGREGATOR
// ============================================================================

export class StrategyAggregator {
  private strategies: Map<string, Strategy> = new Map();

  /**
   * Create a new strategy
   */
  createStrategy(
    name: string,
    type: StrategyType,
    underlying: Underlying,
    expiry: Date,
    atmStrike: number,
    lots: number,
    customLegs?: StrategyLeg[]
  ): Strategy {
    const template = STRATEGY_TEMPLATES[type as keyof typeof STRATEGY_TEMPLATES];
    const legs: StrategyLeg[] = customLegs ?? (template?.legs ?? []);

    if (legs.length === 0) {
      throw new InvalidStrategyError('Strategy must have at least one leg');
    }

    const lotSize = LOT_SIZES[underlying];
    const strikeInterval = getStrikeInterval(underlying);

    // Resolve leg strikes from offsets
    const resolvedLegs: StrategyLeg[] = legs.map(leg => ({
      ...leg,
      strikeOffset: leg.strikeOffset,
      // Will be populated when positions are created
    }));

    const strategy: Strategy = {
      id: uuidv4(),
      name,
      type,
      underlying,
      expiry,
      atmStrike,
      legs: resolvedLegs,
      positions: [],
      status: 'OPEN',
      entryTime: new Date(),
      realizedPnL: ZERO,
      unrealizedPnL: ZERO,
      totalPnL: ZERO,
      breakevens: [],
      margin: ZERO,
      lotSize,
      lots,
    };

    // Calculate max profit/loss and breakevens
    this.calculateRiskReward(strategy);

    this.strategies.set(strategy.id, strategy);

    strategyLogger.info('Strategy created', {
      id: strategy.id,
      name,
      type,
      underlying,
      atmStrike,
      lots,
    });

    eventBus.emit('STRATEGY_CREATED', strategy);

    return strategy;
  }

  /**
   * Generate order requests for a strategy
   */
  generateOrderRequests(strategyId: string): OrderRequest[] {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new StrategyNotFoundError(strategyId);
    }

    const requests: OrderRequest[] = [];
    const strikeInterval = getStrikeInterval(strategy.underlying);

    for (const leg of strategy.legs) {
      const strike = strategy.atmStrike + (leg.strikeOffset * strikeInterval / 100);
      const quantity = strategy.lotSize * strategy.lots * (leg.ratio ?? 1);

      requests.push({
        symbol: this.generateSymbol(strategy.underlying, strategy.expiry, strike, leg.instrumentType),
        underlying: strategy.underlying,
        instrumentType: leg.instrumentType,
        strike,
        expiry: strategy.expiry,
        side: leg.side,
        quantity,
        orderType: 'MARKET',
        strategyId: strategy.id,
      });
    }

    return requests;
  }

  /**
   * Generate trading symbol
   */
  private generateSymbol(
    underlying: Underlying,
    expiry: Date,
    strike: number,
    optionType: 'CE' | 'PE'
  ): string {
    const year = expiry.getFullYear().toString().slice(-2);
    const month = expiry.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const day = expiry.getDate().toString().padStart(2, '0');

    return `${underlying}${year}${month}${day}${strike}${optionType}`;
  }

  /**
   * Link a position to a strategy
   */
  linkPosition(strategyId: string, positionId: string): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new StrategyNotFoundError(strategyId);
    }

    if (!strategy.positions.includes(positionId)) {
      strategy.positions.push(positionId);
    }

    this.updateStrategyPnL(strategyId);
  }

  /**
   * Update strategy P&L from positions
   */
  updateStrategyPnL(strategyId: string): StrategyPnL | undefined {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) return undefined;

    const positionManager = getPositionManager();
    let realized = ZERO;
    let unrealized = ZERO;
    const legs: StrategyPnL['legs'] = [];

    for (const positionId of strategy.positions) {
      const position = positionManager.getPosition(positionId);
      if (!position) continue;

      realized = realized.plus(position.realizedPnL);
      unrealized = unrealized.plus(position.unrealizedPnL);

      legs.push({
        symbol: position.symbol,
        side: position.side,
        realized: position.realizedPnL,
        unrealized: position.unrealizedPnL,
      });
    }

    strategy.realizedPnL = realized;
    strategy.unrealizedPnL = unrealized;
    strategy.totalPnL = realized.plus(unrealized);

    // Update status
    const activePositions = strategy.positions.filter(id => {
      const pos = positionManager.getPosition(id);
      return pos && pos.quantity > 0;
    });

    if (activePositions.length === 0 && strategy.positions.length > 0) {
      strategy.status = 'CLOSED';
      strategy.exitTime = new Date();
      eventBus.emit('STRATEGY_CLOSED', strategy);
    } else if (activePositions.length < strategy.legs.length) {
      strategy.status = 'PARTIAL';
    }

    eventBus.emit('STRATEGY_UPDATED', strategy);

    return {
      strategyId,
      realized,
      unrealized,
      total: strategy.totalPnL,
      legs,
    };
  }

  /**
   * Calculate max profit, max loss, and breakevens
   */
  private calculateRiskReward(strategy: Strategy): void {
    const strikeInterval = getStrikeInterval(strategy.underlying);

    // Different calculations based on strategy type
    switch (strategy.type) {
      case 'SHORT_STRADDLE':
        strategy.maxProfit = undefined; // Will be premium received
        strategy.maxLoss = undefined;   // Unlimited
        strategy.breakevens = []; // Will be calculated after entry
        break;

      case 'SHORT_STRANGLE': {
        const callStrike = strategy.atmStrike + (strategy.legs[0]?.strikeOffset ?? 0) * strikeInterval / 100;
        const putStrike = strategy.atmStrike + (strategy.legs[1]?.strikeOffset ?? 0) * strikeInterval / 100;
        strategy.maxProfit = undefined;
        strategy.maxLoss = undefined;
        // Breakevens are call strike + premium and put strike - premium
        break;
      }

      case 'IRON_FLY':
      case 'IRON_CONDOR': {
        // Max loss = width of wing - net premium
        // Max profit = net premium
        const shortCallStrike = strategy.atmStrike + (strategy.legs[0]?.strikeOffset ?? 0) * strikeInterval / 100;
        const longCallStrike = strategy.atmStrike + (strategy.legs[2]?.strikeOffset ?? 0) * strikeInterval / 100;
        const width = longCallStrike - shortCallStrike;

        // Will be refined after positions are filled with actual premiums
        strategy.maxLoss = toDecimal(width * strategy.lotSize * strategy.lots);
        break;
      }

      case 'BULL_CALL_SPREAD':
      case 'BEAR_PUT_SPREAD': {
        const longStrike = strategy.atmStrike + (strategy.legs[0]?.strikeOffset ?? 0) * strikeInterval / 100;
        const shortStrike = strategy.atmStrike + (strategy.legs[1]?.strikeOffset ?? 0) * strikeInterval / 100;
        const width = Math.abs(shortStrike - longStrike);

        // Max loss = debit paid (will be refined after entry)
        // Max profit = width - debit
        strategy.maxLoss = toDecimal(width * strategy.lotSize * strategy.lots);
        break;
      }

      default:
        // Custom - no pre-calculation
        break;
    }
  }

  /**
   * Recalculate breakevens after entry
   */
  updateBreakevens(strategyId: string, netPremium: Decimal): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) return;

    const strikeInterval = getStrikeInterval(strategy.underlying);
    const premiumPerUnit = netPremium.dividedBy(strategy.lotSize * strategy.lots);

    switch (strategy.type) {
      case 'SHORT_STRADDLE':
        strategy.breakevens = [
          toDecimal(strategy.atmStrike).plus(premiumPerUnit),
          toDecimal(strategy.atmStrike).minus(premiumPerUnit),
        ];
        strategy.maxProfit = netPremium;
        break;

      case 'SHORT_STRANGLE': {
        const callStrike = strategy.atmStrike + (strategy.legs[0]?.strikeOffset ?? 0) * strikeInterval / 100;
        const putStrike = strategy.atmStrike + (strategy.legs[1]?.strikeOffset ?? 0) * strikeInterval / 100;
        strategy.breakevens = [
          toDecimal(callStrike).plus(premiumPerUnit),
          toDecimal(putStrike).minus(premiumPerUnit),
        ];
        strategy.maxProfit = netPremium;
        break;
      }

      case 'IRON_FLY':
      case 'IRON_CONDOR': {
        const shortCallStrike = strategy.atmStrike + (strategy.legs[0]?.strikeOffset ?? 0) * strikeInterval / 100;
        const shortPutStrike = strategy.atmStrike + (strategy.legs[1]?.strikeOffset ?? 0) * strikeInterval / 100;
        const longCallStrike = strategy.atmStrike + (strategy.legs[2]?.strikeOffset ?? 0) * strikeInterval / 100;
        const longPutStrike = strategy.atmStrike + (strategy.legs[3]?.strikeOffset ?? 0) * strikeInterval / 100;

        const width = longCallStrike - shortCallStrike;
        strategy.breakevens = [
          toDecimal(shortCallStrike).plus(premiumPerUnit),
          toDecimal(shortPutStrike).minus(premiumPerUnit),
        ];
        strategy.maxProfit = netPremium;
        strategy.maxLoss = toDecimal(width * strategy.lotSize * strategy.lots).minus(netPremium);
        break;
      }

      default:
        break;
    }

    strategyLogger.info('Breakevens updated', {
      strategyId,
      breakevens: strategy.breakevens.map(b => b.toString()),
      maxProfit: strategy.maxProfit?.toString(),
      maxLoss: strategy.maxLoss?.toString(),
    });
  }

  /**
   * Get strategy by ID
   */
  getStrategy(strategyId: string): Strategy | undefined {
    return this.strategies.get(strategyId);
  }

  /**
   * Get all strategies
   */
  getAllStrategies(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Get open strategies
   */
  getOpenStrategies(): Strategy[] {
    return this.getAllStrategies().filter(s => s.status !== 'CLOSED');
  }

  /**
   * Get strategies for underlying
   */
  getStrategiesForUnderlying(underlying: Underlying): Strategy[] {
    return this.getAllStrategies().filter(s => s.underlying === underlying);
  }

  /**
   * Get aggregate P&L across all strategies
   */
  getAggregateStrategyPnL(): {
    realized: Decimal;
    unrealized: Decimal;
    total: Decimal;
    strategyCount: number;
    openCount: number;
    closedCount: number;
  } {
    let realized = ZERO;
    let unrealized = ZERO;
    let openCount = 0;
    let closedCount = 0;

    for (const strategy of this.strategies.values()) {
      realized = realized.plus(strategy.realizedPnL);
      unrealized = unrealized.plus(strategy.unrealizedPnL);

      if (strategy.status === 'CLOSED') {
        closedCount++;
      } else {
        openCount++;
      }
    }

    return {
      realized,
      unrealized,
      total: realized.plus(unrealized),
      strategyCount: this.strategies.size,
      openCount,
      closedCount,
    };
  }

  /**
   * Close strategy (exit all positions)
   */
  async closeStrategy(
    strategyId: string,
    exitOrdersCallback: (requests: OrderRequest[]) => Promise<void>
  ): Promise<void> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new StrategyNotFoundError(strategyId);
    }

    const positionManager = getPositionManager();
    const exitRequests: OrderRequest[] = [];

    for (const positionId of strategy.positions) {
      const position = positionManager.getPosition(positionId);
      if (!position || position.quantity === 0) continue;

      // Generate exit order (opposite side)
      exitRequests.push({
        symbol: position.symbol,
        underlying: position.underlying,
        instrumentType: position.instrumentType,
        strike: position.strike,
        expiry: position.expiry,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        quantity: position.quantity,
        orderType: 'MARKET',
        strategyId,
        tag: 'EXIT',
      });
    }

    if (exitRequests.length > 0) {
      await exitOrdersCallback(exitRequests);
    }

    strategyLogger.info('Strategy exit initiated', {
      strategyId,
      exitOrders: exitRequests.length,
    });
  }

  /**
   * Clear all strategies
   */
  clear(): void {
    this.strategies.clear();
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let strategyAggregator: StrategyAggregator | null = null;

/**
 * Get StrategyAggregator singleton
 */
export function getStrategyAggregator(): StrategyAggregator {
  if (!strategyAggregator) {
    strategyAggregator = new StrategyAggregator();
  }
  return strategyAggregator;
}

/**
 * Reset StrategyAggregator (for testing)
 */
export function resetStrategyAggregator(): void {
  strategyAggregator?.clear();
  strategyAggregator = null;
}
