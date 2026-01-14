/**
 * Market State Manager for NSE Options Paper Trading
 *
 * Maintains in-memory state of all subscribed instruments.
 * Provides fast access to LTP, bid/ask, depth.
 */

import Decimal from 'decimal.js';
import { eventBus } from '../core/events.js';
import { MarketDataStaleError } from '../core/errors.js';
import { logger } from '../utils/logger.js';
import { toDecimal, ZERO } from '../utils/decimal.js';
import type {
  InstrumentState,
  MarketTick,
  OrderBookDepth,
  Underlying,
  InstrumentType,
  Greeks,
} from '../core/types.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const STALE_THRESHOLD_MS = 30000; // 30 seconds
const CLEANUP_INTERVAL_MS = 60000; // 1 minute

// ============================================================================
// MARKET STATE MANAGER
// ============================================================================

export class MarketStateManager {
  private states: Map<number, InstrumentState> = new Map();
  private symbolToToken: Map<string, number> = new Map();
  private underlyingSpots: Map<Underlying, Decimal> = new Map();
  private cleanupInterval?: NodeJS.Timeout;

  constructor() {
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanupStale(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Update state from tick
   */
  updateFromTick(tick: MarketTick): void {
    const existing = this.states.get(tick.instrumentToken);

    const state: InstrumentState = {
      instrumentToken: tick.instrumentToken,
      tradingSymbol: tick.tradingSymbol,
      underlying: tick.underlying,
      instrumentType: tick.instrumentType,
      strike: tick.strike,
      expiry: tick.expiry,
      ltp: tick.ltp,
      bid: tick.bid,
      ask: tick.ask,
      bidQty: tick.bidQty,
      askQty: tick.askQty,
      volume: tick.volume,
      oi: tick.oi,
      lastUpdate: tick.timestamp,
      depth: tick.depth,
      // Preserve computed fields if they exist
      iv: existing?.iv,
      greeks: existing?.greeks,
    };

    this.states.set(tick.instrumentToken, state);
    this.symbolToToken.set(tick.tradingSymbol, tick.instrumentToken);

    // Update spot price cache
    if (tick.instrumentType === 'SPOT') {
      this.underlyingSpots.set(tick.underlying, tick.ltp);
    }

    // Emit event
    eventBus.emit('TICK', tick);
  }

  /**
   * Update Greeks for an instrument
   */
  updateGreeks(token: number, greeks: Greeks): void {
    const state = this.states.get(token);
    if (state) {
      state.greeks = greeks;
      state.iv = greeks.iv;
    }
  }

  /**
   * Get state by token
   */
  getByToken(token: number): InstrumentState | undefined {
    return this.states.get(token);
  }

  /**
   * Get state by symbol
   */
  getBySymbol(symbol: string): InstrumentState | undefined {
    const token = this.symbolToToken.get(symbol);
    return token ? this.states.get(token) : undefined;
  }

  /**
   * Get LTP for token
   */
  getLTP(token: number): Decimal {
    const state = this.states.get(token);
    return state?.ltp ?? ZERO;
  }

  /**
   * Get bid/ask for token
   */
  getBidAsk(token: number): { bid: Decimal; ask: Decimal } {
    const state = this.states.get(token);
    return {
      bid: state?.bid ?? ZERO,
      ask: state?.ask ?? ZERO,
    };
  }

  /**
   * Get mid price (average of bid and ask)
   */
  getMidPrice(token: number): Decimal {
    const { bid, ask } = this.getBidAsk(token);
    if (bid.isZero() || ask.isZero()) {
      return this.getLTP(token);
    }
    return bid.plus(ask).dividedBy(2);
  }

  /**
   * Get spread
   */
  getSpread(token: number): Decimal {
    const { bid, ask } = this.getBidAsk(token);
    return ask.minus(bid);
  }

  /**
   * Get spread percentage
   */
  getSpreadPercent(token: number): Decimal {
    const { bid, ask } = this.getBidAsk(token);
    const mid = bid.plus(ask).dividedBy(2);
    if (mid.isZero()) return ZERO;
    return ask.minus(bid).dividedBy(mid).times(100);
  }

  /**
   * Get spot price for underlying
   */
  getSpotPrice(underlying: Underlying): Decimal {
    return this.underlyingSpots.get(underlying) ?? ZERO;
  }

  /**
   * Get all spot prices
   */
  getAllSpotPrices(): Map<Underlying, Decimal> {
    return new Map(this.underlyingSpots);
  }

  /**
   * Get order book depth
   */
  getDepth(token: number): OrderBookDepth | undefined {
    return this.states.get(token)?.depth;
  }

  /**
   * Get available liquidity at price levels
   */
  getLiquidity(token: number, levels = 3): { bidLiquidity: number; askLiquidity: number } {
    const depth = this.getDepth(token);
    if (!depth) {
      const state = this.states.get(token);
      return {
        bidLiquidity: state?.bidQty ?? 0,
        askLiquidity: state?.askQty ?? 0,
      };
    }

    let bidLiquidity = 0;
    let askLiquidity = 0;

    for (let i = 0; i < Math.min(levels, depth.buy.length); i++) {
      bidLiquidity += depth.buy[i]?.quantity ?? 0;
    }

    for (let i = 0; i < Math.min(levels, depth.sell.length); i++) {
      askLiquidity += depth.sell[i]?.quantity ?? 0;
    }

    return { bidLiquidity, askLiquidity };
  }

  /**
   * Get IV for instrument
   */
  getIV(token: number): Decimal | undefined {
    return this.states.get(token)?.iv;
  }

  /**
   * Get Greeks for instrument
   */
  getGreeks(token: number): Greeks | undefined {
    return this.states.get(token)?.greeks;
  }

  /**
   * Check if data is stale
   */
  isStale(token: number, thresholdMs = STALE_THRESHOLD_MS): boolean {
    const state = this.states.get(token);
    if (!state) return true;

    const age = Date.now() - state.lastUpdate.getTime();
    return age > thresholdMs;
  }

  /**
   * Get fresh state or throw
   */
  getFresh(token: number, thresholdMs = STALE_THRESHOLD_MS): InstrumentState {
    const state = this.states.get(token);
    if (!state) {
      throw new MarketDataStaleError(`Token ${token}`, new Date(0));
    }

    if (this.isStale(token, thresholdMs)) {
      throw new MarketDataStaleError(state.tradingSymbol, state.lastUpdate);
    }

    return state;
  }

  /**
   * Get all option states for an underlying and expiry
   */
  getOptionStates(underlying: Underlying, expiry?: Date): InstrumentState[] {
    const states: InstrumentState[] = [];

    for (const state of this.states.values()) {
      if (state.underlying !== underlying) continue;
      if (state.instrumentType !== 'CE' && state.instrumentType !== 'PE') continue;

      if (expiry && state.expiry) {
        if (state.expiry.getTime() !== expiry.getTime()) continue;
      }

      states.push(state);
    }

    return states;
  }

  /**
   * Get option chain snapshot
   */
  getOptionChainSnapshot(
    underlying: Underlying,
    expiry: Date,
    strikes: number[]
  ): Map<number, { ce?: InstrumentState; pe?: InstrumentState }> {
    const chain = new Map<number, { ce?: InstrumentState; pe?: InstrumentState }>();

    for (const strike of strikes) {
      const entry: { ce?: InstrumentState; pe?: InstrumentState } = {};

      for (const state of this.states.values()) {
        if (state.underlying !== underlying) continue;
        if (state.strike !== strike) continue;
        if (!state.expiry || state.expiry.getTime() !== expiry.getTime()) continue;

        if (state.instrumentType === 'CE') {
          entry.ce = state;
        } else if (state.instrumentType === 'PE') {
          entry.pe = state;
        }
      }

      if (entry.ce || entry.pe) {
        chain.set(strike, entry);
      }
    }

    return chain;
  }

  /**
   * Get total open interest for expiry
   */
  getTotalOI(underlying: Underlying, expiry: Date): { callOI: number; putOI: number } {
    let callOI = 0;
    let putOI = 0;

    for (const state of this.states.values()) {
      if (state.underlying !== underlying) continue;
      if (!state.expiry || state.expiry.getTime() !== expiry.getTime()) continue;

      if (state.instrumentType === 'CE') {
        callOI += state.oi;
      } else if (state.instrumentType === 'PE') {
        putOI += state.oi;
      }
    }

    return { callOI, putOI };
  }

  /**
   * Get max pain strike (strike with highest combined OI)
   */
  getMaxPainStrike(underlying: Underlying, expiry: Date): number | null {
    const oiByStrike = new Map<number, number>();

    for (const state of this.states.values()) {
      if (state.underlying !== underlying) continue;
      if (!state.expiry || state.expiry.getTime() !== expiry.getTime()) continue;
      if (state.instrumentType !== 'CE' && state.instrumentType !== 'PE') continue;
      if (!state.strike) continue;

      const current = oiByStrike.get(state.strike) ?? 0;
      oiByStrike.set(state.strike, current + state.oi);
    }

    if (oiByStrike.size === 0) return null;

    let maxOI = 0;
    let maxPainStrike = 0;

    for (const [strike, oi] of oiByStrike) {
      if (oi > maxOI) {
        maxOI = oi;
        maxPainStrike = strike;
      }
    }

    return maxPainStrike;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalInstruments: number;
    staleCount: number;
    optionCount: number;
    futuresCount: number;
  } {
    let staleCount = 0;
    let optionCount = 0;
    let futuresCount = 0;

    for (const [token, state] of this.states) {
      if (this.isStale(token)) staleCount++;
      if (state.instrumentType === 'CE' || state.instrumentType === 'PE') {
        optionCount++;
      } else if (state.instrumentType === 'FUT') {
        futuresCount++;
      }
    }

    return {
      totalInstruments: this.states.size,
      staleCount,
      optionCount,
      futuresCount,
    };
  }

  /**
   * Clean up stale entries
   */
  private cleanupStale(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    for (const [token, state] of this.states) {
      const age = now - state.lastUpdate.getTime();
      if (age > maxAge) {
        // Don't remove, just log
        logger.debug(`Stale market data for ${state.tradingSymbol}`, {
          ageSeconds: Math.floor(age / 1000),
        });
      }
    }
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.states.clear();
    this.symbolToToken.clear();
    this.underlyingSpots.clear();
  }

  /**
   * Stop cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let marketState: MarketStateManager | null = null;

/**
 * Get MarketStateManager singleton
 */
export function getMarketState(): MarketStateManager {
  if (!marketState) {
    marketState = new MarketStateManager();
  }
  return marketState;
}

/**
 * Reset MarketStateManager (for testing)
 */
export function resetMarketState(): void {
  if (marketState) {
    marketState.destroy();
    marketState.clear();
  }
  marketState = null;
}
