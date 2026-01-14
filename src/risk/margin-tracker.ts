/**
 * Margin Tracker for NSE Options Paper Trading
 *
 * Tracks margin state across the portfolio in real-time.
 * Integrates with SPAN calculator and kill switch.
 */

import Decimal from 'decimal.js';
import { eventBus } from '../core/events.js';
import { InsufficientMarginError } from '../core/errors.js';
import { logger, logRiskEvent } from '../utils/logger.js';
import { toDecimal, ZERO, formatINR } from '../utils/decimal.js';
import { getMarketState } from '../market-data/market-state.js';
import { calculatePortfolioMargin, SpreadAnalysis } from './span-margin.js';
import { getKillSwitch } from './kill-switch.js';
import type {
  MarginState,
  MarginCalculation,
  Position,
  Underlying,
} from '../core/types.js';

// ============================================================================
// MARGIN TRACKER
// ============================================================================

export class MarginTracker {
  private initialCapital: Decimal;
  private availableMargin: Decimal;
  private usedMargin: Decimal = ZERO;
  private pendingOrderMargin: Decimal = ZERO;
  private realizedPnL: Decimal = ZERO;
  private unrealizedPnL: Decimal = ZERO;
  private marginByPosition: Map<string, MarginCalculation> = new Map();
  private spreadsIdentified: SpreadAnalysis[] = [];
  private lastUpdate?: Date;

  constructor(initialCapital: number) {
    this.initialCapital = new Decimal(initialCapital);
    this.availableMargin = this.initialCapital;

    logger.info('Margin tracker initialized', {
      initialCapital: formatINR(this.initialCapital),
    });
  }

  /**
   * Update margin state from positions
   */
  update(
    positions: Position[],
    spotPrices: Map<Underlying, Decimal>,
    ivs: Map<number, Decimal>
  ): MarginState {
    const openPositions = positions.filter(p => p.quantity > 0);

    // Calculate portfolio margin
    const {
      totalMargin,
      marginByPosition,
      spreadBenefit,
      spreadsIdentified,
    } = calculatePortfolioMargin(openPositions, spotPrices, ivs);

    this.usedMargin = totalMargin;
    this.marginByPosition = marginByPosition;
    this.spreadsIdentified = spreadsIdentified;

    // Calculate unrealized P&L
    this.unrealizedPnL = ZERO;
    for (const pos of openPositions) {
      this.unrealizedPnL = this.unrealizedPnL.plus(pos.unrealizedPnL);
    }

    // Calculate MTM P&L (realized + unrealized)
    const mtmPnL = this.realizedPnL.plus(this.unrealizedPnL);

    // Calculate available margin
    // Available = Initial + Realized P&L - Used Margin - Pending Orders + MTM adjustment
    const mtmAdjustment = this.unrealizedPnL.isNegative()
      ? this.unrealizedPnL // Reduce available by losses
      : ZERO;  // Don't add unrealized gains

    this.availableMargin = this.initialCapital
      .plus(this.realizedPnL)
      .minus(this.usedMargin)
      .minus(this.pendingOrderMargin)
      .plus(mtmAdjustment);

    // Net liquidation value
    const netLiquidation = this.initialCapital
      .plus(this.realizedPnL)
      .plus(this.unrealizedPnL);

    // Margin utilization
    const marginUtilization = this.initialCapital.greaterThan(0)
      ? this.usedMargin.dividedBy(this.initialCapital)
      : ZERO;

    this.lastUpdate = new Date();

    const state: MarginState = {
      initialCapital: this.initialCapital,
      availableMargin: this.availableMargin,
      usedMargin: this.usedMargin,
      marginUtilization,
      pendingOrderMargin: this.pendingOrderMargin,
      mtmPnL,
      realizedPnL: this.realizedPnL,
      netLiquidation,
    };

    // Check with kill switch
    const killSwitch = getKillSwitch();
    killSwitch.check(mtmPnL, state, openPositions);

    return state;
  }

  /**
   * Check if order can be placed (margin available)
   */
  canPlaceOrder(
    requiredMargin: Decimal,
    premiumCredit: Decimal = ZERO
  ): { allowed: boolean; reason?: string } {
    // For long options, no margin needed (premium paid)
    if (requiredMargin.isZero() || requiredMargin.isNegative()) {
      const premiumRequired = requiredMargin.negated();
      if (premiumRequired.greaterThan(this.availableMargin)) {
        return {
          allowed: false,
          reason: `Insufficient funds for premium. Required: ${formatINR(premiumRequired)}, Available: ${formatINR(this.availableMargin)}`,
        };
      }
      return { allowed: true };
    }

    // Net margin after premium credit
    const netRequired = Decimal.max(ZERO, requiredMargin.minus(premiumCredit));

    if (netRequired.greaterThan(this.availableMargin)) {
      return {
        allowed: false,
        reason: `Insufficient margin. Required: ${formatINR(netRequired)}, Available: ${formatINR(this.availableMargin)}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Assert order can be placed (throw if not)
   */
  assertCanPlaceOrder(
    requiredMargin: Decimal,
    premiumCredit: Decimal = ZERO
  ): void {
    const { allowed, reason } = this.canPlaceOrder(requiredMargin, premiumCredit);

    if (!allowed) {
      throw new InsufficientMarginError(
        requiredMargin.toString(),
        this.availableMargin.toString(),
        { reason }
      );
    }
  }

  /**
   * Reserve margin for pending order
   */
  reserveMargin(orderId: string, margin: Decimal): void {
    this.pendingOrderMargin = this.pendingOrderMargin.plus(margin);
    this.availableMargin = this.availableMargin.minus(margin);

    logger.debug('Margin reserved for order', {
      orderId,
      margin: formatINR(margin),
      pendingTotal: formatINR(this.pendingOrderMargin),
    });
  }

  /**
   * Release reserved margin (order cancelled or filled)
   */
  releaseReservedMargin(orderId: string, margin: Decimal): void {
    this.pendingOrderMargin = Decimal.max(ZERO, this.pendingOrderMargin.minus(margin));
    this.availableMargin = this.availableMargin.plus(margin);

    logger.debug('Reserved margin released', {
      orderId,
      margin: formatINR(margin),
      pendingTotal: formatINR(this.pendingOrderMargin),
    });
  }

  /**
   * Add realized P&L from closed position
   */
  addRealizedPnL(amount: Decimal): void {
    const previousRealized = this.realizedPnL;
    this.realizedPnL = this.realizedPnL.plus(amount);

    logger.info('Realized P&L updated', {
      trade: formatINR(amount),
      previous: formatINR(previousRealized),
      new: formatINR(this.realizedPnL),
    });
  }

  /**
   * Get margin for specific position
   */
  getPositionMargin(positionId: string): MarginCalculation | undefined {
    return this.marginByPosition.get(positionId);
  }

  /**
   * Get current margin state
   */
  getState(): MarginState {
    const mtmPnL = this.realizedPnL.plus(this.unrealizedPnL);
    const marginUtilization = this.initialCapital.greaterThan(0)
      ? this.usedMargin.dividedBy(this.initialCapital)
      : ZERO;

    return {
      initialCapital: this.initialCapital,
      availableMargin: this.availableMargin,
      usedMargin: this.usedMargin,
      marginUtilization,
      pendingOrderMargin: this.pendingOrderMargin,
      mtmPnL,
      realizedPnL: this.realizedPnL,
      netLiquidation: this.initialCapital.plus(this.realizedPnL).plus(this.unrealizedPnL),
    };
  }

  /**
   * Get detailed breakdown
   */
  getBreakdown(): {
    state: MarginState;
    byPosition: Map<string, MarginCalculation>;
    spreads: SpreadAnalysis[];
    lastUpdate?: Date;
  } {
    return {
      state: this.getState(),
      byPosition: new Map(this.marginByPosition),
      spreads: [...this.spreadsIdentified],
      lastUpdate: this.lastUpdate,
    };
  }

  /**
   * Reset for new day
   */
  resetDaily(): void {
    logger.info('Daily margin reset', {
      previousRealized: formatINR(this.realizedPnL),
      previousUnrealized: formatINR(this.unrealizedPnL),
    });

    // Carry forward realized P&L to capital
    this.initialCapital = this.initialCapital.plus(this.realizedPnL);
    this.realizedPnL = ZERO;
    this.unrealizedPnL = ZERO;
    this.pendingOrderMargin = ZERO;
    this.marginByPosition.clear();
    this.spreadsIdentified = [];

    this.availableMargin = this.initialCapital.minus(this.usedMargin);

    logger.info('New day capital', {
      capital: formatINR(this.initialCapital),
    });
  }

  /**
   * Update capital (deposit/withdrawal)
   */
  updateCapital(newCapital: Decimal): void {
    const diff = newCapital.minus(this.initialCapital);

    logger.info('Capital updated', {
      previous: formatINR(this.initialCapital),
      new: formatINR(newCapital),
      change: formatINR(diff),
    });

    this.initialCapital = newCapital;
    this.availableMargin = this.availableMargin.plus(diff);
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let marginTracker: MarginTracker | null = null;

/**
 * Get MarginTracker singleton
 */
export function getMarginTracker(initialCapital?: number): MarginTracker {
  if (!marginTracker) {
    if (!initialCapital) {
      throw new Error('Initial capital required for first initialization');
    }
    marginTracker = new MarginTracker(initialCapital);
  }
  return marginTracker;
}

/**
 * Reset MarginTracker (for testing)
 */
export function resetMarginTracker(): void {
  marginTracker = null;
}
