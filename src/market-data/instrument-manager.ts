import { Instrument, OptionChain, Underlying } from '../core/types.js';
import { logger } from '../utils/logger.js';
import path from 'path';

const CACHE_FILE = path.join(process.cwd(), 'data', 'instruments.json');

// Internal type for option chain with market data
interface InstrumentWithPrice extends Instrument {
  lastPrice?: number;
}

interface ChainEntry {
  strike: number;
  ce?: InstrumentWithPrice;
  pe?: InstrumentWithPrice;
}

interface ChainData {
  underlying: Underlying;
  expiry: Date;
  strikes: Map<number, ChainEntry>;
}

export class InstrumentManager {
  // Map of Token -> Instrument
  private instruments: Map<number, InstrumentWithPrice> = new Map();

  // We keep the chain cache for the strategy
  private chains: Map<string, Map<string, ChainData>> = new Map();

  constructor(private kite: any) {} // Use any due to kiteconnect type issues

  async loadInstruments(): Promise<void> {
    try {
      logger.info('Loading instrument master from Zerodha...');
      const instruments = await this.kite.getInstruments('NFO');
      logger.info(`Fetched ${instruments.length} NFO instruments`);

      this.instruments.clear();
      this.chains.clear();

      let count = 0;
      for (const raw of instruments) {
        if (!raw.name || !['NIFTY', 'BANKNIFTY', 'FINNIFTY'].includes(raw.name)) continue;
        
        const expiry = new Date(raw.expiry as string);
        if (isNaN(expiry.getTime())) continue;

        const inst: Instrument = {
          instrumentToken: raw.instrument_token,
          exchangeToken: raw.exchange_token,
          tradingSymbol: raw.tradingsymbol,
          name: raw.name as Underlying,
          lastPrice: 0,
          strike: Number(raw.strike),
          tickSize: raw.tick_size,
          lotSize: raw.lot_size,
          instrumentType: raw.instrument_type as 'CE' | 'PE' | 'FUT',
          segment: raw.segment,
          exchange: raw.exchange,
          expiry: expiry,
        };

        this.instruments.set(inst.instrumentToken, inst);
        this.addToChain(inst);
        count++;
      }
      logger.info(`Successfully loaded ${count} instruments.`);
    } catch (error) {
      logger.error('Failed to load instruments', error);
      throw error;
    }
  }

  private addToChain(inst: InstrumentWithPrice) {
    if (inst.instrumentType === 'FUT') return;

    const und = (inst.name || inst.underlying) as Underlying;
    if (!und) return;

    // Normalize date to string key
    if (!inst.expiry) return;
    const expStr = inst.expiry.toISOString().split('T')[0]; // Use YYYY-MM-DD only

    if (!this.chains.has(und)) this.chains.set(und, new Map());
    const undChains = this.chains.get(und)!;

    if (!undChains.has(expStr)) {
      undChains.set(expStr, { underlying: und, expiry: inst.expiry, strikes: new Map() });
    }

    const chain = undChains.get(expStr)!;
    const strike = inst.strike ?? 0;
    if (!chain.strikes.has(strike)) {
      chain.strikes.set(strike, { strike });
    }

    const entry = chain.strikes.get(strike)!;
    if (inst.instrumentType === 'CE') entry.ce = inst;
    if (inst.instrumentType === 'PE') entry.pe = inst;
  }

  getInstrument(token: number): Instrument | undefined {
    return this.instruments.get(token);
  }

  /**
   * ROBUST METHOD: Iterates all instruments to find unique expiries.
   */
  getAvailableExpiries(underlying: Underlying): Date[] {
    const dates = new Set<number>();
    for (const inst of this.instruments.values()) {
      const instUnd = inst.name || inst.underlying;
      if (instUnd === underlying && inst.instrumentType !== 'FUT' && inst.expiry) {
        dates.add(inst.expiry.getTime());
      }
    }
    return Array.from(dates).sort((a, b) => a - b).map(t => new Date(t));
  }

  getOptionChain(underlying: Underlying, expiry: Date): ChainData | undefined {
    const expStr = expiry.toISOString().split('T')[0]; // Matches addToChain key
    return this.chains.get(underlying)?.get(expStr);
  }

  getOption(underlying: Underlying, expiry: Date, strike: number, type: 'CE' | 'PE'): InstrumentWithPrice | undefined {
    const chain = this.getOptionChain(underlying, expiry);
    if (!chain) return undefined;
    const entry = chain.strikes.get(strike);
    if (!entry) return undefined;
    return type === 'CE' ? entry.ce : entry.pe;
  }

  getLotSize(underlying: Underlying): number {
    for (const inst of this.instruments.values()) {
      const instUnd = inst.name || inst.underlying;
      if (instUnd === underlying && inst.lotSize > 0) return inst.lotSize;
    }
    return underlying === 'BANKNIFTY' ? 30 : 50;
  }

  /**
   * ROBUST METHOD: Direct Filter (Bypasses Map Keys)
   */
  getSubscriptionTokens(underlying: Underlying, strikesCount: number = 10): number[] {
    const allExpiries = this.getAvailableExpiries(underlying);
    if (allExpiries.length === 0) return [];

    const nearestExpiryTime = allExpiries[0]!.getTime();
    const tokens: number[] = [];

    // Brute force filter - guaranteed to work if instruments exist
    for (const inst of this.instruments.values()) {
      const instUnd = inst.name || inst.underlying;
      if (instUnd === underlying &&
          inst.instrumentType !== 'FUT' &&
          inst.expiry &&
          inst.expiry.getTime() === nearestExpiryTime) {
        tokens.push(inst.instrumentToken);
      }
    }

    console.log(`[DEBUG] Found ${tokens.length} tokens for ${underlying} expiry ${allExpiries[0]!.toDateString()}`);
    return tokens;
  }

  getAllInstruments(): InstrumentWithPrice[] {
    return Array.from(this.instruments.values());
  }
}

let instance: InstrumentManager | null = null;

export function getInstrumentManager(kite: any): InstrumentManager {
  if (!instance) instance = new InstrumentManager(kite);
  return instance;
}

export function resetInstrumentManager(): void {
  instance = null;
}