/**
 * NSE Options Paper Trading System - Main Entry Point
 *
 * A near-realistic paper trading system for NIFTY/BANKNIFTY options
 * using Zerodha Kite Connect for live market data.
 *
 * IMPORTANT: This system does NOT place real orders.
 * It simulates execution internally with realistic slippage and latency.
 */

import { KiteConnect } from 'kiteconnect';
import { loadConfig, validateZerodhaConfig } from './config/index.js';
import { logger } from './utils/logger.js';

// Market Data
import { getKiteWebSocket } from './market-data/kite-websocket.js';
import { getMarketState } from './market-data/market-state.js';
import { getInstrumentManager } from './market-data/instrument-manager.js';
import { getSpotTracker } from './market-data/spot-tracker.js';

// Execution
import { getFillEngine } from './execution/fill-engine.js';
import { configureLatency } from './execution/latency.js';

// Risk
import { getMarginTracker } from './risk/margin-tracker.js';
import { getKillSwitch } from './risk/kill-switch.js';

// Position
import { getPositionManager } from './position/position-manager.js';
import { getStrategyAggregator } from './position/strategy-aggregator.js';

// Events
import { eventBus } from './core/events.js';

import type { Underlying } from './core/types.js';

// ============================================================================
// SYSTEM INITIALIZATION
// ============================================================================

export interface TradingSystem {
  kite: KiteConnect;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: boolean;
}

/**
 * Initialize and start the trading system
 */
export async function createTradingSystem(): Promise<TradingSystem> {
  logger.info('Initializing NSE Options Paper Trading System...');

  // Load configuration
  const config = loadConfig();
  validateZerodhaConfig();

  // Initialize Kite Connect
  const kite = new KiteConnect({ api_key: config.zerodha.apiKey });
  kite.setAccessToken(config.zerodha.accessToken);
  logger.info('Kite Connect initialized');

  // Configure execution
  configureLatency({
    minMs: config.execution.latencyMinMs,
    maxMs: config.execution.latencyMaxMs,
    distribution: 'normal',
  });

  // Initialize managers
  const instrumentManager = getInstrumentManager(kite);
  const marginTracker = getMarginTracker(config.risk.initialCapital);
  const killSwitch = getKillSwitch({
    maxDailyLoss: new (await import('decimal.js')).default(config.risk.maxDailyLoss),
    maxDailyLossPct: new (await import('decimal.js')).default(config.risk.maxDailyLossPct),
    marginBreachThreshold: new (await import('decimal.js')).default(config.risk.marginBreachThreshold),
    forceExitOnBreach: config.risk.forceExitOnBreach,
  });

  // Set up force exit callback
  killSwitch.setForceExitCallback(async (positions) => {
    const fillEngine = getFillEngine();
    const positionManager = getPositionManager();

    for (const pos of positions) {
      if (pos.quantity === 0) continue;

      const order = await fillEngine.submitOrder({
        symbol: pos.symbol,
        underlying: pos.underlying,
        instrumentType: pos.instrumentType,
        strike: pos.strike,
        expiry: pos.expiry,
        side: pos.side === 'LONG' ? 'SELL' : 'BUY',
        quantity: pos.quantity,
        orderType: 'MARKET',
        tag: 'KILL_SWITCH_EXIT',
      });

      if (order.status === 'FILLED') {
        positionManager.processOrderFill(order);
      }
    }
  });

  let running = false;

  // Set up event listeners
  setupEventListeners();

  const system: TradingSystem = {
    kite,
    isRunning: false,

    async start() {
      if (running) {
        logger.warn('System already running');
        return;
      }

      logger.info('Starting trading system...');

      // Load instruments
      await instrumentManager.loadInstruments();
      logger.info('Instruments loaded', instrumentManager.getStats());

      // Connect WebSocket
      const ws = getKiteWebSocket(kite, config.zerodha.apiKey, config.zerodha.accessToken);
      await ws.connect();
      logger.info('WebSocket connected');

      // Auto-subscribe to option chains
      await ws.autoSubscribe(
        config.trading.underlyings as Underlying[],
        config.trading.strikesAroundATM
      );
      logger.info('Subscribed to option chains');

      // Start update loop
      startUpdateLoop();

      running = true;
      this.isRunning = true;
      logger.info('Trading system started');
    },

    async stop() {
      if (!running) {
        logger.warn('System not running');
        return;
      }

      logger.info('Stopping trading system...');

      // Stop WebSocket
      const ws = getKiteWebSocket(kite, config.zerodha.apiKey, config.zerodha.accessToken);
      ws.disconnect();

      // Stop fill engine
      const fillEngine = getFillEngine();
      fillEngine.stop();

      running = false;
      this.isRunning = false;
      logger.info('Trading system stopped');
    },
  };

  return system;
}

// ============================================================================
// UPDATE LOOP
// ============================================================================

let updateInterval: NodeJS.Timeout | null = null;

function startUpdateLoop(): void {
  if (updateInterval) return;

  // Update positions and margin every second
  updateInterval = setInterval(() => {
    try {
      const positionManager = getPositionManager();
      const marginTracker = getMarginTracker();
      const marketState = getMarketState();
      const killSwitch = getKillSwitch();

      // Update position prices
      positionManager.updateMarketPrices();

      // Update margin
      const positions = positionManager.getAllPositions();
      const spotPrices = marketState.getAllSpotPrices();
      const ivs = new Map<number, import('decimal.js').default>();

      for (const pos of positions) {
        const state = marketState.getByToken(pos.instrumentToken);
        if (state?.iv) {
          ivs.set(pos.instrumentToken, state.iv);
        }
      }

      const marginState = marginTracker.update(positions, spotPrices, ivs);

      // Check kill switch
      const { realized, unrealized } = positionManager.getAggregatePnL();
      const mtmPnL = realized.plus(unrealized);
      killSwitch.check(mtmPnL, marginState, positions);
    } catch (error) {
      logger.error('Update loop error', { error });
    }
  }, 1000);
}

function stopUpdateLoop(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

function setupEventListeners(): void {
  eventBus.on('ORDER_FILLED', (event) => {
    logger.info(`Order filled: ${event.payload.symbol} ${event.payload.side} ${event.payload.filledQty} @ ${event.payload.avgFillPrice}`);
  });

  eventBus.on('POSITION_OPENED', (event) => {
    logger.info(`Position opened: ${event.payload.symbol} ${event.payload.side} ${event.payload.quantity}`);
  });

  eventBus.on('POSITION_CLOSED', (event) => {
    logger.info(`Position closed: ${event.payload.symbol} | Realized P&L: ${event.payload.realizedPnL}`);
  });

  eventBus.on('KILL_SWITCH_TRIGGERED', (event) => {
    logger.error(`KILL SWITCH TRIGGERED: ${event.payload.reason}`);
  });

  eventBus.on('MARGIN_WARNING', (event) => {
    logger.warn(`Margin warning: ${event.payload.marginUtilization.times(100).toFixed(2)}% utilized`);
  });

  eventBus.on('WEBSOCKET_DISCONNECTED', (event) => {
    logger.warn(`WebSocket disconnected: ${event.payload.reason}`);
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

export { loadConfig, getConfig } from './config/index.js';
export { eventBus } from './core/events.js';
export { logger } from './utils/logger.js';

// Market Data
export { getKiteWebSocket } from './market-data/kite-websocket.js';
export { getMarketState } from './market-data/market-state.js';
export { getInstrumentManager } from './market-data/instrument-manager.js';
export { getSpotTracker } from './market-data/spot-tracker.js';

// Pricing
export * from './pricing/index.js';

// Execution
export { getFillEngine } from './execution/fill-engine.js';
export { calculateSlippage, estimateSlippage } from './execution/slippage.js';

// Risk
export { getMarginTracker } from './risk/margin-tracker.js';
export { getKillSwitch } from './risk/kill-switch.js';
export { calculateOptionMargin, calculatePortfolioMargin } from './risk/span-margin.js';

// Position
export { getPositionManager } from './position/position-manager.js';
export { getStrategyAggregator } from './position/strategy-aggregator.js';

// Types
export * from './core/types.js';
export * from './core/constants.js';

// ============================================================================
// CLI ENTRY
// ============================================================================

// If run directly, start CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  import('./cli/index.js').then(({ runCLI }) => runCLI());
}
