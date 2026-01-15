/**
 * Event System for NSE Options Paper Trading
 *
 * Central event bus for system-wide communication.
 * Uses typed events for compile-time safety.
 */

import EventEmitterConstructor from 'eventemitter3';
const EventEmitter = (EventEmitterConstructor as any).default || EventEmitterConstructor;
import type {
  SystemEvent,
  SystemEventType,
  MarketTick,
  Order,
  Position,
  Trade,
  Strategy,
  KillSwitchEvent,
  MarginState,
} from './types.js';

// ============================================================================
// EVENT PAYLOAD TYPES
// ============================================================================

export interface EventPayloads {
  TICK: MarketTick;
  ORDER_CREATED: Order;
  ORDER_FILLED: Order;
  ORDER_PARTIAL: Order;
  ORDER_CANCELLED: Order;
  ORDER_REJECTED: Order;
  POSITION_OPENED: Position;
  POSITION_UPDATED: Position;
  POSITION_CLOSED: Position & { closingTrade: Trade };
  STRATEGY_CREATED: Strategy;
  STRATEGY_UPDATED: Strategy;
  STRATEGY_CLOSED: Strategy;
  MARGIN_WARNING: MarginState;
  MARGIN_BREACH: MarginState;
  KILL_SWITCH_TRIGGERED: KillSwitchEvent;
  WEBSOCKET_CONNECTED: { timestamp: Date };
  WEBSOCKET_DISCONNECTED: { reason: string; timestamp: Date };
  WEBSOCKET_ERROR: { error: Error; timestamp: Date };
  DAILY_RESET: { date: Date; previousDaySummary?: unknown };
}

// ============================================================================
// TYPED EVENT EMITTER
// ============================================================================

type EventHandler<T extends SystemEventType> = (event: SystemEvent<EventPayloads[T]>) => void;

class TypedEventEmitter {
  private emitter = new EventEmitter();
  private eventHistory: SystemEvent[] = [];
  private maxHistorySize = 1000;

  /**
   * Emit a typed event
   */
  emit<T extends SystemEventType>(type: T, payload: EventPayloads[T]): void {
    const event: SystemEvent<EventPayloads[T]> = {
      type,
      payload,
      timestamp: new Date(),
    };

    // Store in history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    this.emitter.emit(type, event);
    this.emitter.emit('*', event); // Wildcard for logging
  }

  /**
   * Subscribe to a specific event type
   */
  on<T extends SystemEventType>(type: T, handler: EventHandler<T>): void {
    this.emitter.on(type, handler);
  }

  /**
   * Subscribe to all events (for logging/debugging)
   */
  onAll(handler: (event: SystemEvent) => void): void {
    this.emitter.on('*', handler);
  }

  /**
   * Subscribe once to an event
   */
  once<T extends SystemEventType>(type: T, handler: EventHandler<T>): void {
    this.emitter.once(type, handler);
  }

  /**
   * Remove event listener
   */
  off<T extends SystemEventType>(type: T, handler: EventHandler<T>): void {
    this.emitter.off(type, handler);
  }

  /**
   * Remove all listeners for an event type
   */
  removeAllListeners(type?: SystemEventType): void {
    if (type) {
      this.emitter.removeAllListeners(type);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  /**
   * Get event history (for debugging)
   */
  getHistory(type?: SystemEventType, limit = 100): SystemEvent[] {
    let history = this.eventHistory;
    if (type) {
      history = history.filter(e => e.type === type);
    }
    return history.slice(-limit);
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = [];
  }

  /**
   * Get listener count for an event type
   */
  listenerCount(type: SystemEventType): number {
    return this.emitter.listenerCount(type);
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

/**
 * Global event bus instance
 * Import this in any module to emit or subscribe to events
 */
export const eventBus = new TypedEventEmitter();

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Wait for a specific event (promise-based)
 */
export function waitForEvent<T extends SystemEventType>(
  type: T,
  timeoutMs = 30000
): Promise<SystemEvent<EventPayloads[T]>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      eventBus.off(type, handler);
      reject(new Error(`Timeout waiting for event: ${type}`));
    }, timeoutMs);

    const handler: EventHandler<T> = (event) => {
      clearTimeout(timeout);
      eventBus.off(type, handler);
      resolve(event);
    };

    eventBus.on(type, handler);
  });
}

/**
 * Create a filtered event stream
 */
export function createEventFilter<T extends SystemEventType>(
  type: T,
  predicate: (payload: EventPayloads[T]) => boolean
): {
  subscribe: (handler: EventHandler<T>) => void;
  unsubscribe: () => void;
} {
  const handlers: EventHandler<T>[] = [];

  const masterHandler: EventHandler<T> = (event) => {
    if (predicate(event.payload)) {
      handlers.forEach(h => h(event));
    }
  };

  eventBus.on(type, masterHandler);

  return {
    subscribe: (handler: EventHandler<T>) => {
      handlers.push(handler);
    },
    unsubscribe: () => {
      eventBus.off(type, masterHandler);
      handlers.length = 0;
    },
  };
}

/**
 * Log all events (for debugging)
 */
export function enableEventLogging(logger: (msg: string) => void): () => void {
  const handler = (event: SystemEvent) => {
    logger(`[EVENT] ${event.type} at ${event.timestamp.toISOString()}`);
  };

  eventBus.onAll(handler);

  return () => {
    eventBus.removeAllListeners();
  };
}

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type { EventHandler, EventPayloads };
