# NSE Options Paper Trading System - Architecture Document

## Executive Summary

This document describes a **near-realistic options paper trading system** for Indian markets (NIFTY/BANKNIFTY) that uses Zerodha Kite Connect for live market data while simulating execution internally. The system prioritizes **accuracy and realism** over UI polish.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                    EXTERNAL LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐                  │
│  │  Zerodha Kite   │    │  TradingView    │    │     CLI         │                  │
│  │  WebSocket      │    │  Webhooks       │    │   Interface     │                  │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘                  │
│           │                      │                      │                            │
└───────────┼──────────────────────┼──────────────────────┼────────────────────────────┘
            │                      │                      │
┌───────────┼──────────────────────┼──────────────────────┼────────────────────────────┐
│           ▼                      ▼                      ▼                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                           MARKET DATA LAYER                                  │    │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │    │
│  │  │ Tick Handler │ │ Depth Cache  │ │ Spot Tracker │ │ IV Tracker   │        │    │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘        │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                             │
│                                        ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                         OPTIONS PRICING ENGINE                               │    │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │    │
│  │  │ Black-Scholes│ │ IV Surface   │ │ Greeks Calc  │ │ Seller Pain  │        │    │
│  │  │ Calculator   │ │ Manager      │ │ (Δ,Γ,Θ,ν,ρ)  │ │ Modeler      │        │    │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘        │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                             │
│  ┌──────────────────────────────────────┴──────────────────────────────────────┐    │
│  │                                                                              │    │
│  ▼                                                                              ▼    │
│  ┌─────────────────────────────────────┐    ┌─────────────────────────────────────┐ │
│  │       EXECUTION SIMULATOR           │    │        RISK & MARGIN ENGINE         │ │
│  │  ┌──────────────┐ ┌──────────────┐  │    │  ┌──────────────┐ ┌──────────────┐  │ │
│  │  │ Order Queue  │ │ Slippage     │  │    │  │ SPAN Approx  │ │ Kill Switch  │  │ │
│  │  │ Manager      │ │ Calculator   │  │    │  │ Calculator   │ │ Controller   │  │ │
│  │  └──────────────┘ └──────────────┘  │    │  └──────────────┘ └──────────────┘  │ │
│  │  ┌──────────────┐ ┌──────────────┐  │    │  ┌──────────────┐ ┌──────────────┐  │ │
│  │  │ Latency      │ │ Fill Logic   │  │    │  │ Margin       │ │ MTM P&L      │  │ │
│  │  │ Simulator    │ │ Engine       │  │    │  │ Tracker      │ │ Monitor      │  │ │
│  │  └──────────────┘ └──────────────┘  │    │  └──────────────┘ └──────────────┘  │ │
│  └─────────────────────────────────────┘    └─────────────────────────────────────┘ │
│                           │                              │                           │
│                           └──────────────┬───────────────┘                           │
│                                          ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                        POSITION & P&L ENGINE                                 │    │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │    │
│  │  │ Position     │ │ Trade        │ │ Strategy     │ │ P&L          │        │    │
│  │  │ Manager      │ │ Ledger       │ │ Aggregator   │ │ Calculator   │        │    │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘        │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                          │                                           │
│                                          ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                           PERSISTENCE LAYER                                  │    │
│  │  ┌──────────────────────────────────────────────────────────────────────┐   │    │
│  │  │                     SQLite (better-sqlite3)                           │   │    │
│  │  │  Orders │ Trades │ Positions │ MarketSnapshots │ DailyP&L │ Config   │   │    │
│  │  └──────────────────────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                      │
│                              APPLICATION CORE                                        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Module Breakdown

### 1. Market Data Layer (`src/market-data/`)

| Component | Responsibility |
|-----------|----------------|
| `kite-websocket.ts` | WebSocket connection to Zerodha, reconnection handling |
| `tick-handler.ts` | Process incoming ticks, normalize data |
| `market-state.ts` | In-memory state: LTP, bid/ask, timestamp, depth |
| `spot-tracker.ts` | Track underlying spot price movement velocity |
| `instrument-manager.ts` | Load/cache instrument master, option chain mapping |

**Key Data Structure:**
```typescript
interface MarketTick {
  instrumentToken: number;
  tradingSymbol: string;
  ltp: Decimal;
  bid: Decimal;         // Best bid
  ask: Decimal;         // Best ask
  bidQty: number;
  askQty: number;
  volume: number;
  oi: number;           // Open interest (for options)
  timestamp: Date;
  depth?: OrderBookDepth;  // Top 5 levels
}

interface SpotMovement {
  current: Decimal;
  previous: Decimal;
  velocity: Decimal;      // Points per second
  acceleration: Decimal;  // Change in velocity
  direction: 'UP' | 'DOWN' | 'FLAT';
}
```

### 2. Options Pricing Engine (`src/pricing/`)

| Component | Responsibility |
|-----------|----------------|
| `black-scholes.ts` | BS formula for theoretical prices |
| `iv-calculator.ts` | Newton-Raphson IV solver from market prices |
| `greeks-calculator.ts` | Delta, Gamma, Theta, Vega, Rho |
| `iv-surface.ts` | Track IV across strikes and expiries |
| `seller-pain.ts` | Model IV inflation during fast moves |

**IV Inflation Model (Seller Pain):**
```typescript
// When spot moves fast, IV inflates - this hurts option sellers
// Formula: inflatedIV = baseIV * (1 + velocityFactor * direction_multiplier)

interface IVInflationParams {
  baseIV: Decimal;
  spotVelocity: Decimal;        // Points/second
  spotAcceleration: Decimal;    // Change in velocity
  timeToExpiry: number;         // Days
  moneyness: Decimal;           // Strike/Spot ratio
}

// Velocity thresholds (NIFTY)
const VELOCITY_THRESHOLDS = {
  LOW: 5,      // < 5 pts/sec - normal
  MEDIUM: 15,  // 5-15 pts/sec - mild inflation
  HIGH: 30,    // 15-30 pts/sec - significant
  EXTREME: 50  // > 50 pts/sec - panic mode
};
```

### 3. Execution Simulator (`src/execution/`)

| Component | Responsibility |
|-----------|----------------|
| `order-queue.ts` | Queue orders, apply latency |
| `slippage-calculator.ts` | Calculate realistic slippage |
| `fill-engine.ts` | Determine fill price and quantity |
| `latency-simulator.ts` | Add artificial delay (100-1000ms) |

**Slippage Formula:**
```typescript
// Core slippage calculation
interface SlippageFactors {
  baseSlippage: Decimal;      // 0.05-0.10 for liquid options
  volatilityMultiplier: Decimal;
  velocityMultiplier: Decimal;
  spreadFactor: Decimal;
  sizeFactor: Decimal;
}

// BUY: fillPrice = ask + slippage
// SELL: fillPrice = bid - slippage

function calculateSlippage(params: SlippageParams): Decimal {
  const {
    orderType,       // BUY or SELL
    quantity,
    currentBid,
    currentAsk,
    spotVelocity,
    currentIV,
    avgDailyVolume,
    orderBookDepth
  } = params;

  const spread = currentAsk.minus(currentBid);
  const midPrice = currentBid.plus(spread.dividedBy(2));

  // Base slippage: 1-2 ticks for liquid strikes
  let slippage = new Decimal(0.05);  // ₹0.05 base

  // 1. Spread factor: wider spread = more slippage
  const spreadPct = spread.dividedBy(midPrice);
  if (spreadPct.greaterThan(0.02)) {  // > 2% spread
    slippage = slippage.plus(spread.times(0.1));
  }

  // 2. Velocity factor: fast moves = more slippage
  const velocitySlippage = spotVelocity
    .abs()
    .dividedBy(100)
    .times(0.5);  // 50 paisa per 100 pts/sec
  slippage = slippage.plus(velocitySlippage);

  // 3. IV factor: high IV = more slippage
  if (currentIV.greaterThan(25)) {
    const ivExtra = currentIV.minus(25).times(0.02);
    slippage = slippage.plus(ivExtra);
  }

  // 4. Size factor: large orders get worse fills
  const avgTick = avgDailyVolume / 300;  // ~300 mins trading
  const sizeMultiplier = Math.min(2, quantity / avgTick);
  slippage = slippage.times(1 + sizeMultiplier * 0.1);

  // 5. Order book depth factor
  const availableLiquidity = orderType === 'BUY'
    ? sumAskDepth(orderBookDepth, 3)  // Top 3 levels
    : sumBidDepth(orderBookDepth, 3);

  if (quantity > availableLiquidity * 0.5) {
    slippage = slippage.times(1.5);  // Eating into the book
  }

  return slippage;
}
```

**Fill Logic:**
```typescript
interface FillResult {
  filled: boolean;
  fillPrice: Decimal;
  fillQty: number;
  partialFill: boolean;
  slippageApplied: Decimal;
  latencyMs: number;
  timestamp: Date;
}

// For MARKET orders: Always fill at calculated price
// For LIMIT orders: Fill only if limit price is favorable
function executeFill(order: Order, market: MarketState): FillResult {
  const slippage = calculateSlippage(/* ... */);

  let fillPrice: Decimal;
  if (order.side === 'BUY') {
    fillPrice = market.ask.plus(slippage);
    if (order.type === 'LIMIT' && fillPrice.greaterThan(order.limitPrice)) {
      return { filled: false, /* ... */ };
    }
  } else {
    fillPrice = market.bid.minus(slippage);
    if (order.type === 'LIMIT' && fillPrice.lessThan(order.limitPrice)) {
      return { filled: false, /* ... */ };
    }
  }

  return {
    filled: true,
    fillPrice,
    fillQty: order.quantity,
    slippageApplied: slippage,
    latencyMs: randomLatency(100, 500),
    timestamp: new Date()
  };
}
```

### 4. Risk & Margin Engine (`src/risk/`)

| Component | Responsibility |
|-----------|----------------|
| `span-calculator.ts` | Approximate SPAN margin |
| `exposure-calculator.ts` | Calculate exposure margin |
| `margin-tracker.ts` | Track initial, used, available margin |
| `kill-switch.ts` | Daily max-loss enforcement |
| `margin-monitor.ts` | Alert and force-exit on breach |

**SPAN Approximation Logic:**
```typescript
// NSE uses SPAN for F&O margin calculation
// We approximate with simplified rules

interface MarginCalculation {
  spanMargin: Decimal;
  exposureMargin: Decimal;
  totalMargin: Decimal;
  premiumReceived: Decimal;  // For short options
  netMargin: Decimal;        // Total - premium
}

function calculateOptionMargin(position: Position): MarginCalculation {
  const {
    instrumentType,  // CE or PE
    strike,
    side,            // LONG or SHORT
    quantity,
    avgPrice,
    currentSpot,
    currentIV,
    daysToExpiry
  } = position;

  const lotSize = getLotSize(position.underlying);  // 50 for NIFTY, 15 for BANKNIFTY
  const lots = quantity / lotSize;

  if (side === 'LONG') {
    // Long options: margin = premium paid (already debited)
    return {
      spanMargin: new Decimal(0),
      exposureMargin: new Decimal(0),
      totalMargin: new Decimal(0),
      premiumReceived: new Decimal(0),
      netMargin: new Decimal(0)
    };
  }

  // SHORT OPTIONS - This is where margin matters
  const isITM = instrumentType === 'CE'
    ? currentSpot > strike
    : currentSpot < strike;

  const intrinsicValue = isITM
    ? Math.abs(currentSpot - strike)
    : 0;

  // SPAN margin approximation
  // Base: ~15-20% of underlying notional for ATM options
  const notional = currentSpot * lotSize * lots;
  let spanPct: Decimal;

  const moneyness = Math.abs(strike - currentSpot) / currentSpot;

  if (moneyness < 0.02) {
    // ATM: highest margin
    spanPct = new Decimal(0.18);
  } else if (moneyness < 0.05) {
    // Slightly OTM
    spanPct = new Decimal(0.14);
  } else if (moneyness < 0.10) {
    // OTM
    spanPct = new Decimal(0.10);
  } else {
    // Deep OTM
    spanPct = new Decimal(0.07);
  }

  // IV adjustment: higher IV = higher margin
  const ivAdjustment = Decimal.max(1, currentIV / 15);
  spanPct = spanPct.times(ivAdjustment);

  const spanMargin = new Decimal(notional).times(spanPct);

  // Exposure margin: ~3% of notional
  const exposureMargin = new Decimal(notional).times(0.03);

  // Premium received reduces margin requirement
  const premiumReceived = avgPrice * quantity;

  return {
    spanMargin,
    exposureMargin,
    totalMargin: spanMargin.plus(exposureMargin),
    premiumReceived: new Decimal(premiumReceived),
    netMargin: Decimal.max(0, spanMargin.plus(exposureMargin).minus(premiumReceived))
  };
}

// Strategy-level margin benefits (spreads get reduced margin)
function calculateStrategyMargin(positions: Position[]): Decimal {
  // Identify if positions form a spread
  const isSpread = detectSpread(positions);

  if (isSpread) {
    // Spread margin = max loss (much lower than naked positions)
    const maxLoss = calculateMaxLoss(positions);
    return maxLoss.times(1.1);  // 10% buffer
  }

  // No spread benefit - sum individual margins
  return positions.reduce(
    (sum, pos) => sum.plus(calculateOptionMargin(pos).netMargin),
    new Decimal(0)
  );
}
```

**Kill Switch Logic:**
```typescript
interface KillSwitchConfig {
  maxDailyLoss: Decimal;        // e.g., ₹50,000
  maxDailyLossPct: Decimal;     // e.g., 5% of capital
  marginBreachThreshold: Decimal; // e.g., 90% margin utilized
  forceExitOnBreach: boolean;
}

class KillSwitch {
  private triggered = false;
  private dailyPnL = new Decimal(0);

  checkAndEnforce(currentPnL: Decimal, usedMargin: Decimal, totalMargin: Decimal): void {
    if (this.triggered) return;

    // Check daily loss
    if (currentPnL.lessThan(this.config.maxDailyLoss.negated())) {
      this.trigger('DAILY_LOSS_LIMIT');
      return;
    }

    // Check margin utilization
    const marginUtil = usedMargin.dividedBy(totalMargin);
    if (marginUtil.greaterThan(this.config.marginBreachThreshold)) {
      this.trigger('MARGIN_BREACH');
      return;
    }
  }

  private trigger(reason: string): void {
    this.triggered = true;
    this.emit('KILL_SWITCH_TRIGGERED', { reason, timestamp: new Date() });

    if (this.config.forceExitOnBreach) {
      this.forceExitAllPositions();
    }
  }
}
```

### 5. Position & P&L Engine (`src/position/`)

| Component | Responsibility |
|-----------|----------------|
| `position-manager.ts` | Track open positions by instrument |
| `trade-ledger.ts` | Record all executed trades |
| `pnl-calculator.ts` | Realized + Unrealized P&L |
| `strategy-aggregator.ts` | Group positions into strategies |

**Data Models:**
```typescript
// ============ ORDER ============
interface Order {
  id: string;
  strategyId?: string;
  symbol: string;
  instrumentToken: number;
  underlying: 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY';
  instrumentType: 'SPOT' | 'FUT' | 'CE' | 'PE';
  strike?: number;
  expiry: Date;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  limitPrice?: Decimal;
  triggerPrice?: Decimal;
  status: 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED';
  filledQty: number;
  avgFillPrice?: Decimal;
  createdAt: Date;
  updatedAt: Date;
  fills: Fill[];
  tag?: string;  // For strategy grouping
}

// ============ FILL ============
interface Fill {
  id: string;
  orderId: string;
  price: Decimal;
  quantity: number;
  slippage: Decimal;
  latencyMs: number;
  timestamp: Date;
}

// ============ POSITION ============
interface Position {
  id: string;
  symbol: string;
  instrumentToken: number;
  underlying: 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY';
  instrumentType: 'SPOT' | 'FUT' | 'CE' | 'PE';
  strike?: number;
  expiry: Date;
  side: 'LONG' | 'SHORT';
  quantity: number;
  avgPrice: Decimal;
  currentPrice: Decimal;
  realizedPnL: Decimal;
  unrealizedPnL: Decimal;
  margin: Decimal;
  greeks: Greeks;
  openedAt: Date;
  trades: string[];  // Trade IDs
}

// ============ TRADE ============
interface Trade {
  id: string;
  orderId: string;
  positionId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: Decimal;
  slippage: Decimal;
  timestamp: Date;
  pnlImpact: Decimal;  // For closing trades
}

// ============ STRATEGY ============
interface Strategy {
  id: string;
  name: string;
  type: 'SHORT_STRADDLE' | 'SHORT_STRANGLE' | 'IRON_FLY' | 'IRON_CONDOR' | 'CUSTOM';
  legs: StrategyLeg[];
  positions: string[];  // Position IDs
  status: 'OPEN' | 'CLOSED' | 'PARTIAL';
  entryTime: Date;
  exitTime?: Date;
  realizedPnL: Decimal;
  unrealizedPnL: Decimal;
  totalPnL: Decimal;
  maxProfit: Decimal;
  maxLoss: Decimal;
  breakevens: Decimal[];
  margin: Decimal;
}

interface StrategyLeg {
  instrumentType: 'CE' | 'PE';
  strike: number;
  side: 'BUY' | 'SELL';
  quantity: number;
  positionId?: string;
}

// ============ GREEKS ============
interface Greeks {
  delta: Decimal;
  gamma: Decimal;
  theta: Decimal;
  vega: Decimal;
  rho: Decimal;
  iv: Decimal;
}
```

**P&L Calculation:**
```typescript
class PnLCalculator {
  calculateUnrealizedPnL(position: Position, currentPrice: Decimal): Decimal {
    const direction = position.side === 'LONG' ? 1 : -1;
    const priceDiff = currentPrice.minus(position.avgPrice);
    return priceDiff.times(position.quantity).times(direction);
  }

  calculateRealizedPnL(
    openingSide: 'BUY' | 'SELL',
    openingPrice: Decimal,
    closingPrice: Decimal,
    quantity: number
  ): Decimal {
    const direction = openingSide === 'BUY' ? 1 : -1;
    const priceDiff = closingPrice.minus(openingPrice);
    return priceDiff.times(quantity).times(direction);
  }

  calculateStrategyPnL(strategy: Strategy, positions: Position[]): StrategyPnL {
    const positionPnLs = positions.map(pos => ({
      symbol: pos.symbol,
      realized: pos.realizedPnL,
      unrealized: pos.unrealizedPnL
    }));

    return {
      realized: positions.reduce((sum, p) => sum.plus(p.realizedPnL), new Decimal(0)),
      unrealized: positions.reduce((sum, p) => sum.plus(p.unrealizedPnL), new Decimal(0)),
      total: positions.reduce((sum, p) => sum.plus(p.realizedPnL).plus(p.unrealizedPnL), new Decimal(0)),
      legs: positionPnLs
    };
  }
}
```

---

## Common Pitfalls & Mitigations

| Pitfall | Impact | Mitigation |
|---------|--------|------------|
| **Zero slippage assumption** | Wildly optimistic backtests | Always apply minimum 0.05 + velocity-based slippage |
| **Ignoring IV inflation** | Underestimate short option pain | Model IV spikes during fast moves (1.5-2x IV) |
| **Fixed margin** | Margin call surprises | Recalculate margin on every tick |
| **No latency modeling** | False sense of execution speed | Add 100-500ms realistic latency |
| **Ignoring bid-ask spread** | Phantom profits | Always use bid for sells, ask for buys |
| **Depth blindness** | Large orders seem easy | Check order book depth, apply size impact |
| **Expiry day ignore** | Gamma blow-ups | Extra margin buffer on expiry day |
| **Single instrument tokens** | Missing option chain | Subscribe to full chain around ATM |
| **No reconnection logic** | Data gaps during volatility | Exponential backoff + state recovery |
| **Synchronous fills** | Unrealistic execution | Queue + async fill with latency |

---

## Build Plan

### Phase 1: Foundation (Core Infrastructure)
1. ✅ Project setup, TypeScript config
2. Core data models (Orders, Trades, Positions)
3. SQLite persistence layer
4. Configuration management
5. Logging infrastructure

### Phase 2: Market Data & Pricing
1. Kite Connect authentication
2. WebSocket connection with reconnection
3. Tick handler and market state
4. Instrument master loading
5. IV calculator (Newton-Raphson)
6. Greeks calculator
7. Spot velocity tracker

### Phase 3: Execution Engine
1. Order queue with latency simulation
2. Slippage calculator
3. Fill engine
4. Order state machine
5. Partial fill handling

### Phase 4: Risk & Margin
1. SPAN margin approximation
2. Strategy margin benefits
3. Margin tracker
4. Kill switch implementation
5. MTM monitor

### Phase 5: Position Management
1. Position manager
2. Trade ledger
3. P&L calculator
4. Strategy aggregator
5. Multi-leg strategy detection

### Phase 6: Interface Layer
1. CLI for order placement
2. Position/P&L display
3. Webhook server for TradingView
4. Event streaming for UI

---

## Configuration Schema

```typescript
interface SystemConfig {
  zerodha: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    userId: string;
  };

  trading: {
    underlying: ('NIFTY' | 'BANKNIFTY' | 'FINNIFTY')[];
    strikesAroundATM: number;  // e.g., 10 strikes each side
    expiryWeeks: number;       // e.g., 2 (current + next week)
  };

  execution: {
    latencyMinMs: number;      // 100
    latencyMaxMs: number;      // 500
    baseSlippage: number;      // 0.05
    velocitySlippageMultiplier: number;
  };

  risk: {
    initialCapital: number;
    maxDailyLoss: number;
    maxDailyLossPct: number;
    marginBreachThreshold: number;
    forceExitOnBreach: boolean;
  };

  database: {
    path: string;
  };

  webhook: {
    port: number;
    secret: string;
  };
}
```

---

## API Endpoints (Webhook Server)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/order` | Place new order |
| DELETE | `/api/order/:id` | Cancel order |
| GET | `/api/orders` | List orders |
| GET | `/api/positions` | Get positions |
| GET | `/api/pnl` | Get P&L summary |
| POST | `/api/strategy` | Create strategy |
| GET | `/api/market/:symbol` | Get market data |
| POST | `/webhook/tradingview` | TradingView alert |

---

## File Structure

```
options-paper-trading/
├── src/
│   ├── index.ts                 # Main entry point
│   ├── core/
│   │   ├── types.ts             # All TypeScript interfaces
│   │   ├── constants.ts         # Constants and enums
│   │   ├── events.ts            # Event emitter setup
│   │   └── errors.ts            # Custom error classes
│   ├── market-data/
│   │   ├── kite-websocket.ts    # Zerodha WebSocket
│   │   ├── tick-handler.ts      # Tick processing
│   │   ├── market-state.ts      # In-memory state
│   │   ├── spot-tracker.ts      # Velocity tracking
│   │   └── instrument-manager.ts
│   ├── pricing/
│   │   ├── black-scholes.ts     # BS formula
│   │   ├── iv-calculator.ts     # IV solver
│   │   ├── greeks.ts            # Greeks calculation
│   │   └── seller-pain.ts       # IV inflation model
│   ├── execution/
│   │   ├── order-queue.ts       # Order management
│   │   ├── slippage.ts          # Slippage calculator
│   │   ├── fill-engine.ts       # Fill logic
│   │   └── latency.ts           # Latency simulation
│   ├── risk/
│   │   ├── span-margin.ts       # SPAN approximation
│   │   ├── margin-tracker.ts    # Margin tracking
│   │   └── kill-switch.ts       # Kill switch
│   ├── position/
│   │   ├── position-manager.ts  # Position tracking
│   │   ├── trade-ledger.ts      # Trade records
│   │   ├── pnl-calculator.ts    # P&L logic
│   │   └── strategy-aggregator.ts
│   ├── strategies/
│   │   ├── strategy-builder.ts  # Strategy creation
│   │   └── templates.ts         # Straddle, strangle, etc.
│   ├── api/
│   │   ├── webhook-server.ts    # Express server
│   │   └── routes.ts            # API routes
│   ├── cli/
│   │   ├── index.ts             # CLI entry
│   │   └── commands.ts          # CLI commands
│   ├── persistence/
│   │   ├── database.ts          # SQLite setup
│   │   └── repositories.ts      # Data access
│   └── utils/
│       ├── decimal.ts           # Decimal helpers
│       ├── date.ts              # Date utilities
│       └── logger.ts            # Winston logger
├── config/
│   ├── default.json
│   └── production.json
├── docs/
│   └── ARCHITECTURE.md
├── tests/
├── package.json
├── tsconfig.json
└── .env.example
```
