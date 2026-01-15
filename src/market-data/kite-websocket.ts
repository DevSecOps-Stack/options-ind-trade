/**
 * Zerodha Kite WebSocket Handler for NSE Options Paper Trading
 *
 * Handles WebSocket connection, reconnection, and tick processing.
 * IMPORTANT: Read-only connection, no order placement.
 */

import { KiteTicker } from 'kiteconnect';
import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;
import { eventBus } from '../core/events.js';
import { WebSocketConnectionError } from '../core/errors.js';
import { ZERODHA, LATENCY, SPOT_TOKENS } from '../core/constants.js';
import { logger, logMarketData } from '../utils/logger.js';
import { toDecimal, ZERO } from '../utils/decimal.js';
import { getMarketState } from './market-state.js';
import { getSpotTracker } from './spot-tracker.js';
import { getInstrumentManager } from './instrument-manager.js';
import type {
  MarketTick,
  OrderBookDepth,
  DepthLevel,
  Underlying,
  InstrumentType,
} from '../core/types.js';
import type { KiteConnect } from 'kiteconnect';

// ============================================================================
// TYPES
// ============================================================================

interface RawTick {
  instrument_token: number;
  mode: string;
  tradable: boolean;
  last_price: number;
  last_traded_quantity: number;
  average_traded_price: number;
  volume_traded: number;
  total_buy_quantity: number;
  total_sell_quantity: number;
  ohlc?: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
  change?: number;
  last_trade_time?: Date;
  oi?: number;
  oi_day_high?: number;
  oi_day_low?: number;
  depth?: {
    buy: Array<{ price: number; quantity: number; orders: number }>;
    sell: Array<{ price: number; quantity: number; orders: number }>;
  };
}

type TickerMode = 'ltp' | 'quote' | 'full';

// ============================================================================
// KITE WEBSOCKET MANAGER
// ============================================================================

export class KiteWebSocketManager {
  private ticker: KiteTicker | null = null;
  private connected = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private subscriptions: Set<number> = new Set();
  private mode: TickerMode = 'full';

  constructor(
    private kite: KiteConnect,
    private apiKey: string,
    private accessToken: string
  ) {}

  /**
   * Connect to WebSocket
   */
  async connect(): Promise<void> {
    if (this.connected) {
      logger.debug('WebSocket already connected');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        // Create ticker instance
        this.ticker = new KiteTicker({
          api_key: this.apiKey,
          access_token: this.accessToken,
        });

        // Set up event handlers
        this.setupEventHandlers(resolve, reject);

        // Connect
        this.ticker.connect();
        logger.info('Connecting to Zerodha WebSocket...');
      } catch (error) {
        reject(new WebSocketConnectionError(String(error)));
      }
    });
  }

  /**
   * Set up WebSocket event handlers
   */
  private setupEventHandlers(
    onConnect: () => void,
    onError: (error: Error) => void
  ): void {
    if (!this.ticker) return;

    // Connection established
    this.ticker.on('connect', () => {
      this.connected = true;
      this.reconnecting = false;
      this.reconnectAttempts = 0;

      logMarketData('CONNECTED');
      eventBus.emit('WEBSOCKET_CONNECTED', { timestamp: new Date() });

      // Resubscribe if we have pending subscriptions
      if (this.subscriptions.size > 0) {
        this.resubscribe();
      }

      onConnect();
    });

    // Ticks received
    this.ticker.on('ticks', (ticks: RawTick[]) => {
      this.processTicks(ticks);
    });

    // Error
    this.ticker.on('error', (error: Error) => {
      logger.error('WebSocket error', { error: error.message });
      eventBus.emit('WEBSOCKET_ERROR', { error, timestamp: new Date() });

      if (!this.connected) {
        onError(new WebSocketConnectionError(error.message));
      }
    });

    // Disconnection
    this.ticker.on('close', () => {
      this.connected = false;
      logMarketData('DISCONNECTED', { reason: 'connection closed' });
      eventBus.emit('WEBSOCKET_DISCONNECTED', {
        reason: 'Connection closed',
        timestamp: new Date(),
      });
    });

    // Reconnecting
    this.ticker.on('reconnect', (attempts: number, interval: number) => {
      this.reconnecting = true;
      this.reconnectAttempts = attempts;
      logMarketData('RECONNECTING', { attempts, intervalMs: interval });
    });

    // No reconnect (gave up)
    this.ticker.on('noreconnect', () => {
      logger.error('WebSocket reconnection failed permanently');
      this.reconnecting = false;
    });

    // Order update (we don't use this but log it)
    this.ticker.on('order_update', () => {
      logger.debug('Order update received (ignored - paper trading mode)');
    });
  }

  /**
   * Process incoming ticks
   */
  private processTicks(rawTicks: RawTick[]): void {
    const marketState = getMarketState();
    const spotTracker = getSpotTracker();
    const instrumentManager = getInstrumentManager(this.kite);

    for (const raw of rawTicks) {
      try {
        const tick = this.normalizeTick(raw, instrumentManager);
        if (tick) {
          // Update market state
          marketState.updateFromTick(tick);

          // Update spot tracker for underlying indices
          if (tick.instrumentType === 'SPOT') {
            spotTracker.update(tick.underlying, tick.ltp, tick.timestamp);
          }
        }
      } catch (error) {
        logger.debug('Failed to process tick', {
          token: raw.instrument_token,
          error: String(error),
        });
      }
    }
  }

  /**
   * Normalize raw tick to our format
   */
  private normalizeTick(
    raw: RawTick,
    instrumentManager: ReturnType<typeof getInstrumentManager>
  ): MarketTick | null {
    const instrument = instrumentManager.getByToken(raw.instrument_token);
    if (!instrument) {
      // Check if it's a spot index
      const spotEntry = Object.entries(SPOT_TOKENS).find(([, token]) => token === raw.instrument_token);
      if (!spotEntry) return null;

      const underlying = spotEntry[0] as Underlying;
      return {
        instrumentToken: raw.instrument_token,
        tradingSymbol: underlying,
        underlying,
        instrumentType: 'SPOT' as InstrumentType,
        ltp: toDecimal(raw.last_price),
        bid: toDecimal(raw.depth?.buy[0]?.price ?? raw.last_price),
        ask: toDecimal(raw.depth?.sell[0]?.price ?? raw.last_price),
        bidQty: raw.depth?.buy[0]?.quantity ?? 0,
        askQty: raw.depth?.sell[0]?.quantity ?? 0,
        volume: raw.volume_traded,
        oi: 0,
        oiDayHigh: 0,
        oiDayLow: 0,
        lastTradeTime: raw.last_trade_time ?? new Date(),
        timestamp: new Date(),
        depth: this.normalizeDepth(raw.depth),
      };
    }

    // Get bid/ask from depth or use LTP
    let bid = toDecimal(raw.last_price);
    let ask = toDecimal(raw.last_price);
    let bidQty = 0;
    let askQty = 0;

    if (raw.depth) {
      const bestBid = raw.depth.buy[0];
      const bestAsk = raw.depth.sell[0];
      if (bestBid && bestBid.price > 0) {
        bid = toDecimal(bestBid.price);
        bidQty = bestBid.quantity;
      }
      if (bestAsk && bestAsk.price > 0) {
        ask = toDecimal(bestAsk.price);
        askQty = bestAsk.quantity;
      }
    }

    return {
      instrumentToken: raw.instrument_token,
      tradingSymbol: instrument.tradingSymbol,
      underlying: instrument.underlying!,
      instrumentType: instrument.instrumentType as InstrumentType,
      strike: instrument.strike,
      expiry: instrument.expiry,
      ltp: toDecimal(raw.last_price),
      bid,
      ask,
      bidQty,
      askQty,
      volume: raw.volume_traded,
      oi: raw.oi ?? 0,
      oiDayHigh: raw.oi_day_high ?? 0,
      oiDayLow: raw.oi_day_low ?? 0,
      lastTradeTime: raw.last_trade_time ?? new Date(),
      timestamp: new Date(),
      depth: this.normalizeDepth(raw.depth),
    };
  }

  /**
   * Normalize order book depth
   */
  private normalizeDepth(
    raw?: RawTick['depth']
  ): OrderBookDepth | undefined {
    if (!raw) return undefined;

    const normalizeLevel = (level: { price: number; quantity: number; orders: number }): DepthLevel => ({
      price: toDecimal(level.price),
      quantity: level.quantity,
      orders: level.orders,
    });

    return {
      buy: raw.buy.map(normalizeLevel),
      sell: raw.sell.map(normalizeLevel),
    };
  }

  /**
   * Subscribe to instruments
   */
  subscribe(tokens: number[]): void {
    if (!this.ticker || !this.connected) {
      // Queue for later
      tokens.forEach(t => this.subscriptions.add(t));
      logger.debug('Queued subscriptions for later', { count: tokens.length });
      return;
    }

    // Check limit
    if (this.subscriptions.size + tokens.length > ZERODHA.MAX_SUBSCRIPTIONS) {
      logger.warn('Subscription limit approaching', {
        current: this.subscriptions.size,
        adding: tokens.length,
        max: ZERODHA.MAX_SUBSCRIPTIONS,
      });
    }

    // Subscribe in batches
    const batches: number[][] = [];
    for (let i = 0; i < tokens.length; i += ZERODHA.MAX_SUBSCRIPTIONS_PER_MESSAGE) {
      batches.push(tokens.slice(i, i + ZERODHA.MAX_SUBSCRIPTIONS_PER_MESSAGE));
    }

    for (const batch of batches) {
      this.ticker.subscribe(batch);
      this.ticker.setMode(this.mode, batch);
      batch.forEach(t => this.subscriptions.add(t));
    }

    logger.info('Subscribed to instruments', { count: tokens.length });
  }

  /**
   * Unsubscribe from instruments
   */
  unsubscribe(tokens: number[]): void {
    if (!this.ticker || !this.connected) {
      tokens.forEach(t => this.subscriptions.delete(t));
      return;
    }

    this.ticker.unsubscribe(tokens);
    tokens.forEach(t => this.subscriptions.delete(t));

    logger.debug('Unsubscribed from instruments', { count: tokens.length });
  }

  /**
   * Resubscribe after reconnection
   */
  private resubscribe(): void {
    if (this.subscriptions.size === 0) return;

    const tokens = Array.from(this.subscriptions);
    logger.info('Resubscribing after reconnection', { count: tokens.length });

    // Clear and resubscribe
    this.subscriptions.clear();
    this.subscribe(tokens);
  }

  /**
   * Set subscription mode
   */
  setMode(mode: TickerMode): void {
    this.mode = mode;

    if (this.ticker && this.connected && this.subscriptions.size > 0) {
      const tokens = Array.from(this.subscriptions);
      this.ticker.setMode(mode, tokens);
      logger.debug('Changed mode', { mode, tokens: tokens.length });
    }
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get reconnecting status
   */
  isReconnecting(): boolean {
    return this.reconnecting;
  }

  /**
   * Get subscription count
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Get subscribed tokens
   */
  getSubscribedTokens(): number[] {
    return Array.from(this.subscriptions);
  }

  /**
   * Disconnect WebSocket
   */
  disconnect(): void {
    if (this.ticker) {
      this.ticker.disconnect();
      this.ticker = null;
    }
    this.connected = false;
    this.reconnecting = false;
    logger.info('Disconnected from WebSocket');
  }

  /**
   * Auto-subscribe to option chains around ATM
   */
  async autoSubscribe(
    underlyings: Underlying[],
    strikesAroundATM: number
  ): Promise<void> {
    const instrumentManager = getInstrumentManager(this.kite);
    const marketState = getMarketState();

    // First subscribe to spots to get prices
    const spotTokens = underlyings.map(u => SPOT_TOKENS[u]);
    this.subscribe(spotTokens);

    // Wait for spot prices
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get spot prices
    const spotPrices = marketState.getAllSpotPrices();

    // Get all tokens to subscribe
    const tokens = instrumentManager.getSubscriptionTokens(
      underlyings,
      strikesAroundATM,
      spotPrices
    );

    // Subscribe to all
    this.subscribe(tokens);

    logger.info('Auto-subscribed to option chains', {
      underlyings,
      strikesAroundATM,
      totalTokens: tokens.length,
    });
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let wsManager: KiteWebSocketManager | null = null;

/**
 * Get or create KiteWebSocketManager
 */
export function getKiteWebSocket(
  kite: KiteConnect,
  apiKey: string,
  accessToken: string
): KiteWebSocketManager {
  if (!wsManager) {
    wsManager = new KiteWebSocketManager(kite, apiKey, accessToken);
  }
  return wsManager;
}

/**
 * Reset WebSocket manager (for testing)
 */
export function resetKiteWebSocket(): void {
  wsManager?.disconnect();
  wsManager = null;
}
