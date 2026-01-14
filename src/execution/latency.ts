/**
 * Latency Simulator for NSE Options Paper Trading
 *
 * Simulates realistic network and execution latency.
 * Helps prevent over-optimistic backtest results.
 */

import { LATENCY } from '../core/constants.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// LATENCY CONFIGURATION
// ============================================================================

interface LatencyConfig {
  minMs: number;
  maxMs: number;
  highVolatilityExtraMs: number;
  distribution: 'uniform' | 'normal' | 'exponential';
}

let latencyConfig: LatencyConfig = {
  minMs: LATENCY.MIN_MS,
  maxMs: LATENCY.MAX_MS,
  highVolatilityExtraMs: LATENCY.HIGH_VOLATILITY_EXTRA_MS,
  distribution: 'normal',
};

/**
 * Configure latency parameters
 */
export function configureLatency(config: Partial<LatencyConfig>): void {
  latencyConfig = { ...latencyConfig, ...config };
  logger.debug('Latency configured', latencyConfig);
}

/**
 * Get current latency configuration
 */
export function getLatencyConfig(): LatencyConfig {
  return { ...latencyConfig };
}

// ============================================================================
// RANDOM LATENCY GENERATION
// ============================================================================

/**
 * Generate random latency based on distribution
 */
export function getRandomLatency(isHighVolatility = false): number {
  let baseLatency: number;

  switch (latencyConfig.distribution) {
    case 'uniform':
      baseLatency = uniformRandom(latencyConfig.minMs, latencyConfig.maxMs);
      break;

    case 'exponential':
      // Exponential with mean at average of min/max
      const mean = (latencyConfig.minMs + latencyConfig.maxMs) / 2;
      baseLatency = exponentialRandom(mean);
      // Clamp to range
      baseLatency = Math.max(latencyConfig.minMs, Math.min(latencyConfig.maxMs, baseLatency));
      break;

    case 'normal':
    default:
      // Normal distribution centered at mean
      baseLatency = normalRandom(
        (latencyConfig.minMs + latencyConfig.maxMs) / 2,
        (latencyConfig.maxMs - latencyConfig.minMs) / 4
      );
      // Clamp to range
      baseLatency = Math.max(latencyConfig.minMs, Math.min(latencyConfig.maxMs, baseLatency));
      break;
  }

  // Add extra latency during high volatility
  if (isHighVolatility) {
    baseLatency += Math.random() * latencyConfig.highVolatilityExtraMs;
  }

  return Math.round(baseLatency);
}

/**
 * Uniform random between min and max
 */
function uniformRandom(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Normal (Gaussian) random using Box-Muller transform
 */
function normalRandom(mean: number, stdDev: number): number {
  let u1 = Math.random();
  let u2 = Math.random();

  // Avoid log(0)
  while (u1 === 0) u1 = Math.random();

  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

/**
 * Exponential random with given mean
 */
function exponentialRandom(mean: number): number {
  let u = Math.random();
  // Avoid log(0)
  while (u === 0) u = Math.random();

  return -mean * Math.log(u);
}

// ============================================================================
// LATENCY SIMULATION
// ============================================================================

/**
 * Simulate latency by waiting
 */
export function simulateLatency(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Simulate latency with random duration
 */
export async function simulateRandomLatency(isHighVolatility = false): Promise<number> {
  const latency = getRandomLatency(isHighVolatility);
  await simulateLatency(latency);
  return latency;
}

// ============================================================================
// LATENCY QUEUE
// ============================================================================

interface QueuedTask<T> {
  task: () => Promise<T>;
  latencyMs: number;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  queuedAt: Date;
}

/**
 * Latency queue - processes tasks with simulated delay
 */
export class LatencyQueue {
  private queue: QueuedTask<unknown>[] = [];
  private processing = false;
  private stopped = false;

  /**
   * Add task to queue with latency
   */
  enqueue<T>(task: () => Promise<T>, latencyMs?: number): Promise<T> {
    const finalLatency = latencyMs ?? getRandomLatency();

    return new Promise((resolve, reject) => {
      this.queue.push({
        task: task as () => Promise<unknown>,
        latencyMs: finalLatency,
        resolve: resolve as (value: unknown) => void,
        reject,
        queuedAt: new Date(),
      });

      this.processQueue();
    });
  }

  /**
   * Process queued tasks
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.stopped) return;

    this.processing = true;

    while (this.queue.length > 0 && !this.stopped) {
      const item = this.queue.shift();
      if (!item) continue;

      try {
        // Wait for latency
        await simulateLatency(item.latencyMs);

        if (this.stopped) {
          item.reject(new Error('Queue stopped'));
          continue;
        }

        // Execute task
        const result = await item.task();
        item.resolve(result);
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.processing = false;
  }

  /**
   * Get queue length
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Clear the queue
   */
  clear(): void {
    for (const item of this.queue) {
      item.reject(new Error('Queue cleared'));
    }
    this.queue = [];
  }

  /**
   * Stop processing
   */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  /**
   * Resume processing
   */
  resume(): void {
    this.stopped = false;
    this.processQueue();
  }
}

// ============================================================================
// LATENCY STATISTICS
// ============================================================================

interface LatencyStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
}

/**
 * Track latency statistics
 */
export class LatencyTracker {
  private samples: number[] = [];
  private maxSamples = 10000;

  /**
   * Record a latency sample
   */
  record(latencyMs: number): void {
    this.samples.push(latencyMs);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * Get latency statistics
   */
  getStats(): LatencyStats {
    if (this.samples.length === 0) {
      return {
        count: 0,
        min: 0,
        max: 0,
        mean: 0,
        median: 0,
        p95: 0,
        p99: 0,
      };
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const count = sorted.length;

    return {
      count,
      min: sorted[0]!,
      max: sorted[count - 1]!,
      mean: sorted.reduce((a, b) => a + b, 0) / count,
      median: sorted[Math.floor(count / 2)]!,
      p95: sorted[Math.floor(count * 0.95)]!,
      p99: sorted[Math.floor(count * 0.99)]!,
    };
  }

  /**
   * Clear samples
   */
  clear(): void {
    this.samples = [];
  }
}

// Singleton tracker
const latencyTracker = new LatencyTracker();
export { latencyTracker };
