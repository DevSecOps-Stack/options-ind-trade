/**
 * Risk Module Exports
 */

export {
  calculateOptionMargin,
  calculateFuturesMargin,
  calculatePortfolioMargin,
  analyzeSpread,
} from './span-margin.js';
export type { SpreadAnalysis } from './span-margin.js';

export {
  KillSwitch,
  getKillSwitch,
  resetKillSwitch,
} from './kill-switch.js';
export type { KillSwitchConfig } from './kill-switch.js';

export {
  MarginTracker,
  getMarginTracker,
  resetMarginTracker,
} from './margin-tracker.js';
