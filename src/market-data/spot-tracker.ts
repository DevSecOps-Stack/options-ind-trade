/**
 * Spot Price Tracker for NSE Options Paper Trading
 *
 * Tracks spot price velocity and acceleration.
 * Used for slippage calculation and IV inflation modeling.
 */

import Decimal from 'decimal.js';
import { SLIPPAGE } from '../core/constants.js';
import { logger } from '../utils/logger.js';
import { toDecimal, ZERO } from '../utils/decimal.js';
import type { Underlying, SpotMovement, SpotSample, SpotDirection } from '../core/types.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const SAMPLE_WINDOW_SIZE = 10;      // Keep last 10 samples
const SAMPLE_INTERVAL_MS = 500;     // Sample every 500ms
const VELOCITY_WINDOW_MS = 5000;    // Calculate velocity over 5 seconds

// ============================================================================
// SPOT TRACKER
// ============================================================================

export class SpotTracker {
  private samples: Map<Underlying, SpotSample[]> = new Map();
  private lastSampleTime: Map<Underlying, number> = new Map();
  private movements: Map<Underlying, SpotMovement> = new Map();

  constructor() {
    // Initialize for each underlying
    for (const underlying of ['NIFTY', 'BANKNIFTY', 'FINNIFTY'] as Underlying[]) {
      this.samples.set(underlying, []);
      this.movements.set(underlying, {
        underlying,
        current: ZERO,
        previous: ZERO,
        velocity: ZERO,
        acceleration: ZERO,
        direction: 'FLAT',
        timestamp: new Date(),
        samples: [],
      });
    }
  }

  /**
   * Update spot price (called on each tick)
   */
  update(underlying: Underlying, price: Decimal, timestamp: Date = new Date()): void {
    const samples = this.samples.get(underlying)!;
    const lastTime = this.lastSampleTime.get(underlying) ?? 0;
    const now = timestamp.getTime();

    // Only sample at interval
    if (now - lastTime < SAMPLE_INTERVAL_MS) {
      return;
    }

    // Add new sample
    samples.push({ price, timestamp });
    this.lastSampleTime.set(underlying, now);

    // Keep only window size
    while (samples.length > SAMPLE_WINDOW_SIZE) {
      samples.shift();
    }

    // Calculate movement
    this.calculateMovement(underlying);
  }

  /**
   * Calculate velocity and acceleration
   */
  private calculateMovement(underlying: Underlying): void {
    const samples = this.samples.get(underlying)!;
    if (samples.length < 2) return;

    const current = samples[samples.length - 1]!;
    const previous = samples[samples.length - 2]!;

    // Find oldest sample within velocity window
    const windowStart = current.timestamp.getTime() - VELOCITY_WINDOW_MS;
    let oldestInWindow = samples[0]!;

    for (const sample of samples) {
      if (sample.timestamp.getTime() >= windowStart) {
        oldestInWindow = sample;
        break;
      }
    }

    // Calculate velocity (points per second)
    const timeDiffSeconds = (current.timestamp.getTime() - oldestInWindow.timestamp.getTime()) / 1000;
    const priceDiff = current.price.minus(oldestInWindow.price);

    let velocity = ZERO;
    if (timeDiffSeconds > 0) {
      velocity = priceDiff.dividedBy(timeDiffSeconds);
    }

    // Calculate acceleration (change in velocity)
    const previousMovement = this.movements.get(underlying)!;
    const previousVelocity = previousMovement.velocity;
    const acceleration = velocity.minus(previousVelocity);

    // Determine direction
    let direction: SpotDirection = 'FLAT';
    if (velocity.greaterThan(1)) {
      direction = 'UP';
    } else if (velocity.lessThan(-1)) {
      direction = 'DOWN';
    }

    // Update movement
    const movement: SpotMovement = {
      underlying,
      current: current.price,
      previous: previous.price,
      velocity,
      acceleration,
      direction,
      timestamp: current.timestamp,
      samples: [...samples],
    };

    this.movements.set(underlying, movement);

    // Log significant moves
    if (velocity.abs().greaterThan(SLIPPAGE.VELOCITY_HIGH)) {
      logger.warn(`High velocity detected for ${underlying}`, {
        velocity: velocity.toFixed(2),
        direction,
        price: current.price.toFixed(2),
      });
    }
  }

  /**
   * Get current movement for underlying
   */
  getMovement(underlying: Underlying): SpotMovement {
    return this.movements.get(underlying)!;
  }

  /**
   * Get velocity for underlying
   */
  getVelocity(underlying: Underlying): Decimal {
    return this.movements.get(underlying)?.velocity ?? ZERO;
  }

  /**
   * Get absolute velocity for underlying
   */
  getAbsoluteVelocity(underlying: Underlying): Decimal {
    return this.getVelocity(underlying).abs();
  }

  /**
   * Get direction for underlying
   */
  getDirection(underlying: Underlying): SpotDirection {
    return this.movements.get(underlying)?.direction ?? 'FLAT';
  }

  /**
   * Get acceleration for underlying
   */
  getAcceleration(underlying: Underlying): Decimal {
    return this.movements.get(underlying)?.acceleration ?? ZERO;
  }

  /**
   * Get velocity category
   */
  getVelocityCategory(underlying: Underlying): 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' {
    const velocity = this.getAbsoluteVelocity(underlying);

    if (velocity.greaterThanOrEqualTo(SLIPPAGE.VELOCITY_EXTREME)) {
      return 'EXTREME';
    }
    if (velocity.greaterThanOrEqualTo(SLIPPAGE.VELOCITY_HIGH)) {
      return 'HIGH';
    }
    if (velocity.greaterThanOrEqualTo(SLIPPAGE.VELOCITY_MEDIUM)) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  /**
   * Get velocity multiplier for slippage calculation
   */
  getVelocityMultiplier(underlying: Underlying): Decimal {
    const category = this.getVelocityCategory(underlying);

    switch (category) {
      case 'EXTREME':
        return new Decimal(2.0);
      case 'HIGH':
        return new Decimal(1.5);
      case 'MEDIUM':
        return new Decimal(1.2);
      case 'LOW':
      default:
        return new Decimal(1.0);
    }
  }

  /**
   * Get IV inflation factor based on velocity
   */
  getIVInflationFactor(underlying: Underlying): Decimal {
    const category = this.getVelocityCategory(underlying);
    const direction = this.getDirection(underlying);
    const acceleration = this.getAcceleration(underlying);

    // Base inflation by category
    let factor: Decimal;
    switch (category) {
      case 'EXTREME':
        factor = new Decimal(1.5);  // 50% IV inflation
        break;
      case 'HIGH':
        factor = new Decimal(1.3);  // 30% IV inflation
        break;
      case 'MEDIUM':
        factor = new Decimal(1.15); // 15% IV inflation
        break;
      case 'LOW':
      default:
        factor = new Decimal(1.0);
    }

    // Additional inflation if accelerating
    if (acceleration.abs().greaterThan(1)) {
      factor = factor.times(1.1);  // Extra 10% if accelerating
    }

    return factor;
  }

  /**
   * Check if market is in panic mode (extreme velocity + acceleration)
   */
  isPanicMode(underlying: Underlying): boolean {
    const velocity = this.getAbsoluteVelocity(underlying);
    const acceleration = this.getAcceleration(underlying).abs();

    return velocity.greaterThan(SLIPPAGE.VELOCITY_EXTREME) && acceleration.greaterThan(5);
  }

  /**
   * Get range over time window
   */
  getRange(underlying: Underlying): { high: Decimal; low: Decimal; range: Decimal } {
    const samples = this.samples.get(underlying)!;
    if (samples.length === 0) {
      return { high: ZERO, low: ZERO, range: ZERO };
    }

    let high = samples[0]!.price;
    let low = samples[0]!.price;

    for (const sample of samples) {
      if (sample.price.greaterThan(high)) high = sample.price;
      if (sample.price.lessThan(low)) low = sample.price;
    }

    return { high, low, range: high.minus(low) };
  }

  /**
   * Get volatility estimate (standard deviation of returns)
   */
  getVolatilityEstimate(underlying: Underlying): Decimal {
    const samples = this.samples.get(underlying)!;
    if (samples.length < 3) return ZERO;

    // Calculate returns
    const returns: Decimal[] = [];
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1]!;
      const curr = samples[i]!;
      if (prev.price.greaterThan(0)) {
        returns.push(curr.price.minus(prev.price).dividedBy(prev.price));
      }
    }

    if (returns.length === 0) return ZERO;

    // Calculate mean
    const mean = returns.reduce((sum, r) => sum.plus(r), ZERO).dividedBy(returns.length);

    // Calculate variance
    const variance = returns
      .reduce((sum, r) => sum.plus(r.minus(mean).pow(2)), ZERO)
      .dividedBy(returns.length);

    // Return standard deviation (annualized)
    const stdDev = variance.sqrt();
    // Annualize: multiply by sqrt(252 * 6.25 * 3600 / 0.5) assuming 500ms samples
    // Simplified: just return the raw std dev scaled
    return stdDev.times(100);  // As percentage
  }

  /**
   * Get all movements
   */
  getAllMovements(): Map<Underlying, SpotMovement> {
    return new Map(this.movements);
  }

  /**
   * Clear data for underlying
   */
  clear(underlying?: Underlying): void {
    if (underlying) {
      this.samples.set(underlying, []);
      this.lastSampleTime.delete(underlying);
    } else {
      for (const u of this.samples.keys()) {
        this.samples.set(u, []);
      }
      this.lastSampleTime.clear();
    }
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let spotTracker: SpotTracker | null = null;

/**
 * Get SpotTracker singleton
 */
export function getSpotTracker(): SpotTracker {
  if (!spotTracker) {
    spotTracker = new SpotTracker();
  }
  return spotTracker;
}

/**
 * Reset SpotTracker (for testing)
 */
export function resetSpotTracker(): void {
  spotTracker?.clear();
  spotTracker = null;
}
