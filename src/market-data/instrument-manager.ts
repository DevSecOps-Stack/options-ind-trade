/**
 * Instrument Manager for NSE Options Paper Trading
 *
 * Loads and caches instrument master data from Zerodha.
 * Maps symbols to tokens for WebSocket subscriptions.
 */

import Decimal from 'decimal.js';
import { KiteConnect } from 'kiteconnect';
import {
  LOT_SIZES,
  STRIKE_INTERVALS,
  SPOT_TOKENS,
  EXCHANGE_SEGMENTS,
} from '../core/constants.js';
import { InstrumentNotFoundError } from '../core/errors.js';
import { logger } from '../utils/logger.js';
import { getNextExpiries, parseExpiry, formatExpiry } from '../utils/date.js';
import type { Instrument, Underlying, InstrumentType } from '../core/types.js';

// ============================================================================
// TYPES
// ============================================================================

interface RawInstrument {
  instrument_token: number;
  exchange_token: number;
  tradingsymbol: string;
  name: string;
  exchange: string;
  segment: string;
  instrument_type: string;
  strike?: number;
  expiry?: string;
  lot_size: number;
  tick_size: number;
}

interface OptionChainEntry {
  strike: number;
  ce?: Instrument;
  pe?: Instrument;
}

interface ExpiryChain {
  expiry: Date;
  strikes: Map<number, OptionChainEntry>;
  atmStrike: number;
}

// ============================================================================
// INSTRUMENT MANAGER
// ============================================================================

export class InstrumentManager {
  private instruments: Map<number, Instrument> = new Map();
  private symbolToToken: Map<string, number> = new Map();
  private optionChains: Map<Underlying, Map<string, ExpiryChain>> = new Map();
  private futuresInstruments: Map<Underlying, Map<string, Instrument>> = new Map();
  private loaded = false;

  constructor(private kite: KiteConnect) {
    // Initialize underlying maps
    for (const underlying of ['NIFTY', 'BANKNIFTY', 'FINNIFTY'] as Underlying[]) {
      this.optionChains.set(underlying, new Map());
      this.futuresInstruments.set(underlying, new Map());
    }
  }

  /**
   * Load instrument master from Zerodha
   */
  async loadInstruments(): Promise<void> {
    if (this.loaded) {
      logger.debug('Instruments already loaded');
      return;
    }

    logger.info('Loading instrument master from Zerodha...');

    try {
      // Fetch NFO instruments
      const rawInstruments = await this.kite.getInstruments([EXCHANGE_SEGMENTS.NFO]) as RawInstrument[];

      logger.info(`Fetched ${rawInstruments.length} NFO instruments`);

      // Get next 4 expiries for filtering
      const relevantExpiries = getNextExpiries(4);
      const expiryDates = new Set(relevantExpiries.map(e => formatExpiry(e)));

      let optionCount = 0;
      let futuresCount = 0;

      for (const raw of rawInstruments) {
        // Skip if not relevant underlying
        const underlying = this.extractUnderlying(raw.name, raw.tradingsymbol);
        if (!underlying) continue;

        // Skip if not relevant expiry
        if (raw.expiry) {
          const expiryStr = formatExpiry(new Date(raw.expiry));
          if (!expiryDates.has(expiryStr)) continue;
        }

        const instrument = this.normalizeInstrument(raw, underlying);
        this.instruments.set(instrument.instrumentToken, instrument);
        this.symbolToToken.set(instrument.tradingSymbol, instrument.instrumentToken);

        // Organize by type
        if (instrument.instrumentType === 'FUT') {
          const expiryKey = formatExpiry(instrument.expiry!);
          this.futuresInstruments.get(underlying)!.set(expiryKey, instrument);
          futuresCount++;
        } else if (instrument.instrumentType === 'CE' || instrument.instrumentType === 'PE') {
          this.addToOptionChain(underlying, instrument);
          optionCount++;
        }
      }

      // Add spot indices
      for (const [underlying, token] of Object.entries(SPOT_TOKENS)) {
        const spotInstrument: Instrument = {
          instrumentToken: token,
          exchangeToken: token,
          tradingSymbol: underlying,
          name: underlying,
          exchange: 'NSE',
          segment: 'INDICES',
          instrumentType: 'SPOT',
          lotSize: LOT_SIZES[underlying as Underlying],
          tickSize: 0.05,
          underlying: underlying as Underlying,
        };
        this.instruments.set(token, spotInstrument);
        this.symbolToToken.set(underlying, token);
      }

      this.loaded = true;
      logger.info(`Loaded ${optionCount} options, ${futuresCount} futures, 3 spot indices`);
    } catch (error) {
      logger.error('Failed to load instruments', { error });
      throw error;
    }
  }

  /**
   * Extract underlying from instrument name
   */
  private extractUnderlying(name: string, symbol: string): Underlying | null {
    if (name === 'NIFTY' || symbol.startsWith('NIFTY')) return 'NIFTY';
    if (name === 'BANKNIFTY' || symbol.startsWith('BANKNIFTY')) return 'BANKNIFTY';
    if (name === 'FINNIFTY' || symbol.startsWith('FINNIFTY')) return 'FINNIFTY';
    return null;
  }

  /**
   * Normalize raw instrument to our format
   */
  private normalizeInstrument(raw: RawInstrument, underlying: Underlying): Instrument {
    let instrumentType: InstrumentType = 'SPOT';
    if (raw.instrument_type === 'FUT') instrumentType = 'FUT';
    else if (raw.instrument_type === 'CE') instrumentType = 'CE';
    else if (raw.instrument_type === 'PE') instrumentType = 'PE';

    return {
      instrumentToken: raw.instrument_token,
      exchangeToken: raw.exchange_token,
      tradingSymbol: raw.tradingsymbol,
      name: raw.name,
      exchange: raw.exchange,
      segment: raw.segment,
      instrumentType: raw.instrument_type,
      strike: raw.strike,
      expiry: raw.expiry ? new Date(raw.expiry) : undefined,
      lotSize: raw.lot_size,
      tickSize: raw.tick_size,
      underlying,
    };
  }

  /**
   * Add instrument to option chain structure
   */
  private addToOptionChain(underlying: Underlying, instrument: Instrument): void {
    if (!instrument.expiry || !instrument.strike) return;

    const expiryKey = formatExpiry(instrument.expiry);
    const chains = this.optionChains.get(underlying)!;

    if (!chains.has(expiryKey)) {
      chains.set(expiryKey, {
        expiry: instrument.expiry,
        strikes: new Map(),
        atmStrike: 0,
      });
    }

    const chain = chains.get(expiryKey)!;
    const strike = instrument.strike;

    if (!chain.strikes.has(strike)) {
      chain.strikes.set(strike, { strike });
    }

    const entry = chain.strikes.get(strike)!;
    if (instrument.instrumentType === 'CE') {
      entry.ce = instrument;
    } else if (instrument.instrumentType === 'PE') {
      entry.pe = instrument;
    }
  }

  /**
   * Get instrument by token
   */
  getByToken(token: number): Instrument | undefined {
    return this.instruments.get(token);
  }

  /**
   * Get instrument by symbol
   */
  getBySymbol(symbol: string): Instrument | undefined {
    const token = this.symbolToToken.get(symbol);
    return token ? this.instruments.get(token) : undefined;
  }

  /**
   * Get instrument token for symbol
   */
  getToken(symbol: string): number {
    const token = this.symbolToToken.get(symbol);
    if (!token) {
      throw new InstrumentNotFoundError(symbol);
    }
    return token;
  }

  /**
   * Get spot instrument for underlying
   */
  getSpot(underlying: Underlying): Instrument {
    const token = SPOT_TOKENS[underlying];
    const instrument = this.instruments.get(token);
    if (!instrument) {
      throw new InstrumentNotFoundError(`${underlying} spot`);
    }
    return instrument;
  }

  /**
   * Get futures instrument for expiry
   */
  getFutures(underlying: Underlying, expiry: Date): Instrument | undefined {
    const expiryKey = formatExpiry(expiry);
    return this.futuresInstruments.get(underlying)?.get(expiryKey);
  }

  /**
   * Get option instrument
   */
  getOption(
    underlying: Underlying,
    expiry: Date,
    strike: number,
    optionType: 'CE' | 'PE'
  ): Instrument | undefined {
    const expiryKey = formatExpiry(expiry);
    const chain = this.optionChains.get(underlying)?.get(expiryKey);
    if (!chain) return undefined;

    const entry = chain.strikes.get(strike);
    return optionType === 'CE' ? entry?.ce : entry?.pe;
  }

  /**
   * Get option chain for expiry
   */
  getOptionChain(underlying: Underlying, expiry: Date): ExpiryChain | undefined {
    const expiryKey = formatExpiry(expiry);
    return this.optionChains.get(underlying)?.get(expiryKey);
  }

  /**
   * Get strikes around ATM
   */
  getStrikesAroundATM(
    underlying: Underlying,
    expiry: Date,
    spotPrice: Decimal,
    count: number
  ): number[] {
    const chain = this.getOptionChain(underlying, expiry);
    if (!chain) return [];

    const strikeInterval = STRIKE_INTERVALS[underlying];
    const atmStrike = Math.round(spotPrice.toNumber() / strikeInterval) * strikeInterval;

    const strikes: number[] = [];
    for (let i = -count; i <= count; i++) {
      const strike = atmStrike + i * strikeInterval;
      if (chain.strikes.has(strike)) {
        strikes.push(strike);
      }
    }

    // Update ATM in chain
    chain.atmStrike = atmStrike;

    return strikes.sort((a, b) => a - b);
  }

  /**
   * Get all tokens for subscription
   */
  getSubscriptionTokens(
    underlyings: Underlying[],
    strikesAroundATM: number,
    spotPrices: Map<Underlying, Decimal>
  ): number[] {
    const tokens: number[] = [];

    for (const underlying of underlyings) {
      // Add spot token
      tokens.push(SPOT_TOKENS[underlying]);

      const spotPrice = spotPrices.get(underlying);
      if (!spotPrice) continue;

      // Get next 2 expiries
      const expiries = getNextExpiries(2);

      for (const expiry of expiries) {
        // Add futures
        const futures = this.getFutures(underlying, expiry);
        if (futures) {
          tokens.push(futures.instrumentToken);
        }

        // Add options around ATM
        const strikes = this.getStrikesAroundATM(underlying, expiry, spotPrice, strikesAroundATM);
        for (const strike of strikes) {
          const ce = this.getOption(underlying, expiry, strike, 'CE');
          const pe = this.getOption(underlying, expiry, strike, 'PE');
          if (ce) tokens.push(ce.instrumentToken);
          if (pe) tokens.push(pe.instrumentToken);
        }
      }
    }

    return [...new Set(tokens)]; // Remove duplicates
  }

  /**
   * Get lot size for underlying
   */
  getLotSize(underlying: Underlying): number {
    return LOT_SIZES[underlying];
  }

  /**
   * Get strike interval for underlying
   */
  getStrikeInterval(underlying: Underlying): number {
    return STRIKE_INTERVALS[underlying];
  }

  /**
   * Get available expiries for underlying
   */
  getAvailableExpiries(underlying: Underlying): Date[] {
    const chains = this.optionChains.get(underlying);
    if (!chains) return [];

    const expiries: Date[] = [];
    for (const chain of chains.values()) {
      expiries.push(chain.expiry);
    }

    return expiries.sort((a, b) => a.getTime() - b.getTime());
  }

  /**
   * Get all loaded instruments count
   */
  getStats(): { total: number; options: number; futures: number } {
    let options = 0;
    let futures = 0;

    for (const inst of this.instruments.values()) {
      if (inst.instrumentType === 'CE' || inst.instrumentType === 'PE') {
        options++;
      } else if (inst.instrumentType === 'FUT') {
        futures++;
      }
    }

    return { total: this.instruments.size, options, futures };
  }

  /**
   * Check if instruments are loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Clear all data (for refresh)
   */
  clear(): void {
    this.instruments.clear();
    this.symbolToToken.clear();
    for (const chain of this.optionChains.values()) {
      chain.clear();
    }
    for (const futures of this.futuresInstruments.values()) {
      futures.clear();
    }
    this.loaded = false;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let instrumentManager: InstrumentManager | null = null;

/**
 * Get or create InstrumentManager instance
 */
export function getInstrumentManager(kite: KiteConnect): InstrumentManager {
  if (!instrumentManager) {
    instrumentManager = new InstrumentManager(kite);
  }
  return instrumentManager;
}

/**
 * Reset InstrumentManager (for testing)
 */
export function resetInstrumentManager(): void {
  if (instrumentManager) {
    instrumentManager.clear();
  }
  instrumentManager = null;
}
