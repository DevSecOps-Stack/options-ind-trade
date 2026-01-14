/**
 * Kill Switch for NSE Options Paper Trading
 *
 * Automatic risk control mechanism that:
 * - Monitors daily P&L
 * - Tracks margin utilization
 * - Force-exits positions when thresholds breached
 */

import Decimal from 'decimal.js';
import { RISK } from '../core/constants.js';
import { eventBus } from '../core/events.js';
import { KillSwitchActiveError } from '../core/errors.js';
import { logger, logRiskEvent } from '../utils/logger.js';
import { toDecimal, ZERO, formatINR, formatWithSign } from '../utils/decimal.js';
import type {
  KillSwitchEvent,
  KillSwitchReason,
  MarginState,
  Position,
} from '../core/types.js';

// ============================================================================
// KILL SWITCH CONFIGURATION
// ============================================================================

export interface KillSwitchConfig {
  maxDailyLoss: Decimal;
  maxDailyLossPct: Decimal;
  marginBreachThreshold: Decimal;
  pnlWarningThreshold: Decimal;
  marginWarningThreshold: Decimal;
  forceExitOnBreach: boolean;
  cooldownMinutes: number;
}

const defaultConfig: KillSwitchConfig = {
  maxDailyLoss: new Decimal(RISK.DEFAULT_MAX_DAILY_LOSS),
  maxDailyLossPct: new Decimal(RISK.DEFAULT_MAX_DAILY_LOSS_PCT),
  marginBreachThreshold: new Decimal(RISK.DEFAULT_MARGIN_BREACH_THRESHOLD),
  pnlWarningThreshold: new Decimal(RISK.PNL_WARNING_THRESHOLD),
  marginWarningThreshold: new Decimal(RISK.MARGIN_WARNING_THRESHOLD),
  forceExitOnBreach: true,
  cooldownMinutes: 30,
};

// ============================================================================
// KILL SWITCH MANAGER
// ============================================================================

export class KillSwitch {
  private config: KillSwitchConfig;
  private triggered = false;
  private triggeredAt?: Date;
  private triggeredReason?: KillSwitchReason;
  private dailyPnL = ZERO;
  private peakPnL = ZERO;
  private troughPnL = ZERO;
  private warningsSent = new Set<string>();
  private lastCheck?: Date;
  private forceExitCallback?: (positions: Position[]) => Promise<void>;

  constructor(config: Partial<KillSwitchConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
    logger.info('Kill switch initialized', {
      maxDailyLoss: this.config.maxDailyLoss.toString(),
      marginBreachThreshold: this.config.marginBreachThreshold.toString(),
    });
  }

  /**
   * Set force exit callback
   */
  setForceExitCallback(callback: (positions: Position[]) => Promise<void>): void {
    this.forceExitCallback = callback;
  }

  /**
   * Check thresholds and trigger if needed
   */
  check(
    currentPnL: Decimal,
    marginState: MarginState,
    openPositions: Position[]
  ): KillSwitchEvent {
    this.lastCheck = new Date();
    this.dailyPnL = currentPnL;

    // Track peak and trough
    if (currentPnL.greaterThan(this.peakPnL)) {
      this.peakPnL = currentPnL;
    }
    if (currentPnL.lessThan(this.troughPnL)) {
      this.troughPnL = currentPnL;
    }

    // If already triggered, check cooldown
    if (this.triggered) {
      return this.getTriggeredState();
    }

    const event: KillSwitchEvent = {
      triggered: false,
      dailyPnL: this.dailyPnL,
      marginUtilization: marginState.marginUtilization,
    };

    // Check daily loss limit (absolute)
    if (currentPnL.lessThan(this.config.maxDailyLoss.negated())) {
      return this.trigger('DAILY_LOSS_LIMIT', openPositions, {
        currentLoss: currentPnL.toString(),
        maxLoss: this.config.maxDailyLoss.toString(),
      });
    }

    // Check daily loss limit (percentage)
    const pnlPct = currentPnL.dividedBy(marginState.initialCapital);
    if (pnlPct.lessThan(this.config.maxDailyLossPct.negated())) {
      return this.trigger('DAILY_LOSS_LIMIT', openPositions, {
        currentLossPct: pnlPct.times(100).toFixed(2) + '%',
        maxLossPct: this.config.maxDailyLossPct.times(100).toFixed(2) + '%',
      });
    }

    // Check margin breach
    if (marginState.marginUtilization.greaterThan(this.config.marginBreachThreshold)) {
      return this.trigger('MARGIN_BREACH', openPositions, {
        marginUtilization: marginState.marginUtilization.times(100).toFixed(2) + '%',
        threshold: this.config.marginBreachThreshold.times(100).toFixed(2) + '%',
      });
    }

    // Warnings (don't trigger, just alert)
    this.checkWarnings(currentPnL, marginState);

    return event;
  }

  /**
   * Check for warning conditions
   */
  private checkWarnings(currentPnL: Decimal, marginState: MarginState): void {
    // P&L warning
    const pnlPct = currentPnL.dividedBy(marginState.initialCapital).abs();
    const pnlWarningKey = `pnl_${Math.floor(pnlPct.times(100).toNumber())}`;

    if (
      currentPnL.isNegative() &&
      pnlPct.greaterThan(this.config.pnlWarningThreshold) &&
      !this.warningsSent.has(pnlWarningKey)
    ) {
      this.warningsSent.add(pnlWarningKey);

      logRiskEvent('MARGIN_WARNING', {
        type: 'PNL_WARNING',
        currentLoss: formatWithSign(currentPnL),
        lossPct: pnlPct.times(100).toFixed(2) + '%',
      });

      eventBus.emit('MARGIN_WARNING', marginState);
    }

    // Margin warning
    const marginWarningKey = `margin_${Math.floor(marginState.marginUtilization.times(100).toNumber())}`;

    if (
      marginState.marginUtilization.greaterThan(this.config.marginWarningThreshold) &&
      !this.warningsSent.has(marginWarningKey)
    ) {
      this.warningsSent.add(marginWarningKey);

      logRiskEvent('MARGIN_WARNING', {
        type: 'MARGIN_UTILIZATION',
        marginUtilization: marginState.marginUtilization.times(100).toFixed(2) + '%',
      });

      eventBus.emit('MARGIN_WARNING', marginState);
    }
  }

  /**
   * Trigger the kill switch
   */
  private trigger(
    reason: KillSwitchReason,
    openPositions: Position[],
    details: Record<string, string>
  ): KillSwitchEvent {
    this.triggered = true;
    this.triggeredAt = new Date();
    this.triggeredReason = reason;

    const message = this.formatTriggerMessage(reason, details);

    logRiskEvent('KILL_SWITCH', {
      reason,
      ...details,
    });

    logger.error(`KILL SWITCH TRIGGERED: ${reason}`, details);

    const event: KillSwitchEvent = {
      triggered: true,
      reason,
      timestamp: this.triggeredAt,
      dailyPnL: this.dailyPnL,
      marginUtilization: ZERO, // Will be set by caller
      message,
    };

    eventBus.emit('KILL_SWITCH_TRIGGERED', event);

    // Force exit if configured
    if (this.config.forceExitOnBreach && this.forceExitCallback && openPositions.length > 0) {
      this.executeForceExit(openPositions);
    }

    return event;
  }

  /**
   * Execute force exit of all positions
   */
  private async executeForceExit(positions: Position[]): Promise<void> {
    if (!this.forceExitCallback) {
      logger.warn('Force exit requested but no callback configured');
      return;
    }

    logger.warn('Executing force exit of all positions', {
      positionCount: positions.length,
    });

    try {
      await this.forceExitCallback(positions);
      logger.info('Force exit completed');
    } catch (error) {
      logger.error('Force exit failed', { error });
    }
  }

  /**
   * Format trigger message for display
   */
  private formatTriggerMessage(reason: KillSwitchReason, details: Record<string, string>): string {
    switch (reason) {
      case 'DAILY_LOSS_LIMIT':
        return `Daily loss limit breached. Current: ${details['currentLoss'] ?? details['currentLossPct']}, Limit: ${details['maxLoss'] ?? details['maxLossPct']}`;

      case 'MARGIN_BREACH':
        return `Margin breach. Utilization: ${details['marginUtilization']}, Threshold: ${details['threshold']}`;

      case 'MANUAL':
        return 'Kill switch triggered manually';

      case 'ERROR':
        return 'Kill switch triggered due to system error';

      default:
        return `Kill switch triggered: ${reason}`;
    }
  }

  /**
   * Get triggered state
   */
  private getTriggeredState(): KillSwitchEvent {
    return {
      triggered: true,
      reason: this.triggeredReason,
      timestamp: this.triggeredAt,
      dailyPnL: this.dailyPnL,
      marginUtilization: ZERO,
      message: 'Kill switch already active',
    };
  }

  /**
   * Manually trigger kill switch
   */
  manualTrigger(reason = 'User requested'): KillSwitchEvent {
    return this.trigger('MANUAL', [], { reason });
  }

  /**
   * Reset kill switch (start of new day or manual)
   */
  reset(): void {
    if (this.triggered) {
      logger.info('Kill switch reset', {
        wasTriggeredAt: this.triggeredAt?.toISOString(),
        wasReason: this.triggeredReason,
        dailyPnL: this.dailyPnL.toString(),
      });
    }

    this.triggered = false;
    this.triggeredAt = undefined;
    this.triggeredReason = undefined;
    this.dailyPnL = ZERO;
    this.peakPnL = ZERO;
    this.troughPnL = ZERO;
    this.warningsSent.clear();
  }

  /**
   * Check if kill switch is active
   */
  isTriggered(): boolean {
    return this.triggered;
  }

  /**
   * Assert kill switch is not active (throw if it is)
   */
  assertNotTriggered(): void {
    if (this.triggered) {
      throw new KillSwitchActiveError(this.triggeredReason ?? 'Unknown');
    }
  }

  /**
   * Get current status
   */
  getStatus(): {
    triggered: boolean;
    triggeredAt?: Date;
    reason?: KillSwitchReason;
    dailyPnL: Decimal;
    peakPnL: Decimal;
    troughPnL: Decimal;
    maxDrawdown: Decimal;
    lastCheck?: Date;
    config: KillSwitchConfig;
  } {
    return {
      triggered: this.triggered,
      triggeredAt: this.triggeredAt,
      reason: this.triggeredReason,
      dailyPnL: this.dailyPnL,
      peakPnL: this.peakPnL,
      troughPnL: this.troughPnL,
      maxDrawdown: this.peakPnL.minus(this.troughPnL),
      lastCheck: this.lastCheck,
      config: { ...this.config },
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<KillSwitchConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('Kill switch config updated', {
      maxDailyLoss: this.config.maxDailyLoss.toString(),
      marginBreachThreshold: this.config.marginBreachThreshold.toString(),
    });
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let killSwitch: KillSwitch | null = null;

/**
 * Get KillSwitch singleton
 */
export function getKillSwitch(config?: Partial<KillSwitchConfig>): KillSwitch {
  if (!killSwitch) {
    killSwitch = new KillSwitch(config);
  }
  return killSwitch;
}

/**
 * Reset KillSwitch (for testing or new day)
 */
export function resetKillSwitch(): void {
  killSwitch?.reset();
  killSwitch = null;
}
