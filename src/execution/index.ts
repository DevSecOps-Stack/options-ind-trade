/**
 * Execution Module Exports
 */

export {
  calculateSlippage,
  calculateFillPrice,
  calculateDepthFills,
  calculateAverageFillPrice,
  estimateSlippage,
  SlippageAnalyzer,
  slippageAnalyzer,
} from './slippage.js';
export type { DepthFill, SlippageRecord } from './slippage.js';

export {
  FillEngine,
  getFillEngine,
  resetFillEngine,
} from './fill-engine.js';

export {
  configureLatency,
  getLatencyConfig,
  getRandomLatency,
  simulateLatency,
  simulateRandomLatency,
  LatencyQueue,
  LatencyTracker,
  latencyTracker,
} from './latency.js';
