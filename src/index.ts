/**
 * NSE Options Paper Trading System - Library Entry Point
 */

import { KiteConnect } from 'kiteconnect';
import { loadConfig, validateZerodhaConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { getKiteWebSocket } from './market-data/kite-websocket.js';
import { getInstrumentManager } from './market-data/instrument-manager.js';
import { getMarginTracker } from './risk/margin-tracker.js';
import { getKillSwitch } from './risk/kill-switch.js';
import type { Underlying } from './core/types.js';

// ============================================================================
// EXPORTS
// ============================================================================

export { loadConfig, getConfig } from './config/index.js';
export { eventBus } from './core/events.js';
export { logger } from './utils/logger.js';
export { getKiteWebSocket } from './market-data/kite-websocket.js';
export { getMarketState } from './market-data/market-state.js';
export { getInstrumentManager } from './market-data/instrument-manager.js';
export { getSpotTracker } from './market-data/spot-tracker.js';
export * from './pricing/index.js';
export { getFillEngine } from './execution/fill-engine.js';
export { calculateSlippage, estimateSlippage } from './execution/slippage.js';
export { getMarginTracker } from './risk/margin-tracker.js';
export { getKillSwitch } from './risk/kill-switch.js';
export { getPositionManager } from './position/position-manager.js';
export { getStrategyAggregator } from './position/strategy-aggregator.js';
export * from './core/types.js';
export * from './core/constants.js';

// NOTE: No CLI code here! CLI code lives in src/cli/index.ts