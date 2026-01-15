/**
 * Webhook Server for NSE Options Paper Trading
 *
 * Receives TradingView alerts and executes orders.
 * Also provides REST API for external integrations.
 */

import express, { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../config/index.js';
import { logger, apiLogger } from '../utils/logger.js';
import { formatINR, toDecimal } from '../utils/decimal.js';
import { getFillEngine } from '../execution/fill-engine.js';
import { getPositionManager } from '../position/position-manager.js';
import { getStrategyAggregator } from '../position/strategy-aggregator.js';
import { getMarginTracker } from '../risk/margin-tracker.js';
import { getKillSwitch } from '../risk/kill-switch.js';
import { getMarketState } from '../market-data/market-state.js';
import { WEBHOOK } from '../core/constants.js';
import type {
  TradingViewAlert,
  ApiResponse,
  OrderRequest,
  Underlying,
  OrderType,
} from '../core/types.js';
import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;

// ============================================================================
// SERVER SETUP
// ============================================================================

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  apiLogger.debug(`${req.method} ${req.path}`, {
    ip: req.ip,
    body: req.body,
  });
  next();
});

// Rate limiting (simple in-memory)
const requestCounts = new Map<string, { count: number; resetTime: number }>();

app.use((req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const window = requestCounts.get(ip);

  if (!window || now > window.resetTime) {
    requestCounts.set(ip, {
      count: 1,
      resetTime: now + WEBHOOK.RATE_LIMIT_WINDOW_MS,
    });
    return next();
  }

  window.count++;

  if (window.count > WEBHOOK.RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      timestamp: new Date(),
    });
  }

  next();
});

// IP whitelist
app.use((req: Request, res: Response, next: NextFunction) => {
  const config = loadConfig();

  if (config.webhook.allowedIPs.length === 0) {
    return next(); // No whitelist configured
  }

  const ip = req.ip ?? '';
  if (!config.webhook.allowedIPs.includes(ip)) {
    apiLogger.warn('Rejected request from unauthorized IP', { ip });
    return res.status(403).json({
      success: false,
      error: 'IP not allowed',
      timestamp: new Date(),
    });
  }

  next();
});

// Secret verification
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health') {
    return next(); // Skip auth for health check
  }

  const config = loadConfig();

  if (!config.webhook.secret) {
    return next(); // No secret configured
  }

  const secret = req.headers['x-webhook-secret'] ?? req.body?.secret;

  if (secret !== config.webhook.secret) {
    apiLogger.warn('Invalid webhook secret');
    return res.status(401).json({
      success: false,
      error: 'Invalid secret',
      timestamp: new Date(),
    });
  }

  next();
});

// ============================================================================
// ROUTES
// ============================================================================

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      uptime: process.uptime(),
    },
    timestamp: new Date(),
  });
});

// TradingView webhook
app.post('/webhook/tradingview', async (req: Request, res: Response) => {
  try {
    const alert = parseTradingViewAlert(req.body);

    if (!alert) {
      return res.status(400).json({
        success: false,
        error: 'Invalid alert format',
        timestamp: new Date(),
      });
    }

    apiLogger.info('TradingView alert received', alert);

    // Check kill switch
    const killSwitch = getKillSwitch();
    if (killSwitch.isTriggered()) {
      return res.status(503).json({
        success: false,
        error: 'Kill switch is active - trading disabled',
        timestamp: new Date(),
      });
    }

    // Execute based on action
    let result: ApiResponse<unknown>;

    switch (alert.action) {
      case 'BUY':
      case 'SELL':
        result = await executeOrder(alert);
        break;
      case 'CLOSE':
        result = await closePosition(alert);
        break;
      default:
        result = {
          success: false,
          error: `Unknown action: ${alert.action}`,
          timestamp: new Date(),
        };
    }

    res.json(result);
  } catch (error) {
    apiLogger.error('Webhook error', { error });
    res.status(500).json({
      success: false,
      error: String(error),
      timestamp: new Date(),
    });
  }
});

// Place order
app.post('/api/order', async (req: Request, res: Response) => {
  try {
    const {
      symbol,
      underlying,
      instrumentType,
      strike,
      expiry,
      side,
      quantity,
      orderType,
      limitPrice,
      strategyId,
    } = req.body;

    if (!symbol || !side || !quantity) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: symbol, side, quantity',
        timestamp: new Date(),
      });
    }

    const orderRequest: OrderRequest = {
      symbol,
      underlying: underlying ?? 'NIFTY',
      instrumentType: instrumentType ?? 'CE',
      strike,
      expiry: expiry ? new Date(expiry) : new Date(),
      side,
      quantity,
      orderType: orderType ?? 'MARKET',
      limitPrice: limitPrice ? new Decimal(limitPrice) : undefined,
      strategyId,
    };

    const fillEngine = getFillEngine();
    const order = await fillEngine.submitOrder(orderRequest);

    if (order.status === 'FILLED') {
      const positionManager = getPositionManager();
      positionManager.processOrderFill(order);
    }

    res.json({
      success: true,
      data: {
        orderId: order.id,
        status: order.status,
        avgFillPrice: order.avgFillPrice?.toString(),
      },
      timestamp: new Date(),
    });
  } catch (error) {
    apiLogger.error('Order placement error', { error });
    res.status(500).json({
      success: false,
      error: String(error),
      timestamp: new Date(),
    });
  }
});

// Cancel order
app.delete('/api/order/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const fillEngine = getFillEngine();
    const order = fillEngine.cancelOrder(id);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found or already filled',
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      data: { orderId: id, status: 'CANCELLED' },
      timestamp: new Date(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: String(error),
      timestamp: new Date(),
    });
  }
});

// Get orders
app.get('/api/orders', (_req: Request, res: Response) => {
  const fillEngine = getFillEngine();
  const orders = fillEngine.getPendingOrders();

  res.json({
    success: true,
    data: orders.map(o => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      quantity: o.quantity,
      filledQty: o.filledQty,
      status: o.status,
      createdAt: o.createdAt,
    })),
    timestamp: new Date(),
  });
});

// Get positions
app.get('/api/positions', (_req: Request, res: Response) => {
  const positionManager = getPositionManager();
  const positions = positionManager.getAllPositions();

  res.json({
    success: true,
    data: positions.map(p => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      avgPrice: p.avgPrice.toString(),
      currentPrice: p.currentPrice.toString(),
      unrealizedPnL: p.unrealizedPnL.toString(),
      realizedPnL: p.realizedPnL.toString(),
    })),
    timestamp: new Date(),
  });
});

// Get P&L
app.get('/api/pnl', (_req: Request, res: Response) => {
  const positionManager = getPositionManager();
  const pnl = positionManager.getAggregatePnL();
  const greeks = positionManager.getNetGreeks();

  res.json({
    success: true,
    data: {
      realized: pnl.realized.toString(),
      unrealized: pnl.unrealized.toString(),
      total: pnl.total.toString(),
      positionCount: pnl.positionCount,
      tradeCount: pnl.tradeCount,
      greeks: {
        delta: greeks.delta.toString(),
        gamma: greeks.gamma.toString(),
        theta: greeks.theta.toString(),
        vega: greeks.vega.toString(),
      },
    },
    timestamp: new Date(),
  });
});

// Get margin status
app.get('/api/margin', (_req: Request, res: Response) => {
  const marginTracker = getMarginTracker();
  const state = marginTracker.getState();

  res.json({
    success: true,
    data: {
      initialCapital: state.initialCapital.toString(),
      availableMargin: state.availableMargin.toString(),
      usedMargin: state.usedMargin.toString(),
      marginUtilization: state.marginUtilization.times(100).toFixed(2) + '%',
      mtmPnL: state.mtmPnL.toString(),
      netLiquidation: state.netLiquidation.toString(),
    },
    timestamp: new Date(),
  });
});

// Get market data
app.get('/api/market/:symbol', (req: Request, res: Response) => {
  const { symbol } = req.params;
  const marketState = getMarketState();
  const state = marketState.getBySymbol(symbol);

  if (!state) {
    return res.status(404).json({
      success: false,
      error: 'Symbol not found',
      timestamp: new Date(),
    });
  }

  res.json({
    success: true,
    data: {
      symbol: state.tradingSymbol,
      ltp: state.ltp.toString(),
      bid: state.bid.toString(),
      ask: state.ask.toString(),
      volume: state.volume,
      oi: state.oi,
      iv: state.iv?.toString(),
      lastUpdate: state.lastUpdate,
    },
    timestamp: new Date(),
  });
});

// Kill switch status
app.get('/api/killswitch', (_req: Request, res: Response) => {
  const killSwitch = getKillSwitch();
  const status = killSwitch.getStatus();

  res.json({
    success: true,
    data: {
      triggered: status.triggered,
      reason: status.reason,
      triggeredAt: status.triggeredAt,
      dailyPnL: status.dailyPnL.toString(),
      maxDrawdown: status.maxDrawdown.toString(),
    },
    timestamp: new Date(),
  });
});

// Manual kill switch trigger
app.post('/api/killswitch/trigger', (_req: Request, res: Response) => {
  const killSwitch = getKillSwitch();
  killSwitch.manualTrigger('API request');

  res.json({
    success: true,
    data: { triggered: true },
    timestamp: new Date(),
  });
});

// Reset kill switch
app.post('/api/killswitch/reset', (_req: Request, res: Response) => {
  const killSwitch = getKillSwitch();
  killSwitch.reset();

  res.json({
    success: true,
    data: { triggered: false },
    timestamp: new Date(),
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function parseTradingViewAlert(body: unknown): TradingViewAlert | null {
  if (!body || typeof body !== 'object') return null;

  const data = body as Record<string, unknown>;

  // Support various TradingView alert formats
  const action = (data['action'] ?? data['order'] ?? data['signal']) as string;

  if (!action) return null;

  return {
    action: action.toUpperCase() as 'BUY' | 'SELL' | 'CLOSE',
    symbol: (data['symbol'] ?? data['ticker']) as string,
    underlying: (data['underlying'] ?? 'NIFTY') as Underlying,
    instrumentType: data['instrumentType'] as 'CE' | 'PE' | undefined,
    strike: data['strike'] as number | undefined,
    expiry: data['expiry'] as string | undefined,
    quantity: data['quantity'] as number | undefined,
    orderType: (data['orderType'] ?? 'MARKET') as OrderType,
    limitPrice: data['limitPrice'] as number | undefined,
    strategyId: data['strategyId'] as string | undefined,
    message: data['message'] as string | undefined,
  };
}

async function executeOrder(alert: TradingViewAlert): Promise<ApiResponse<unknown>> {
  if (!alert.symbol) {
    return {
      success: false,
      error: 'Symbol is required',
      timestamp: new Date(),
    };
  }

  const orderRequest: OrderRequest = {
    symbol: alert.symbol,
    underlying: alert.underlying ?? 'NIFTY',
    instrumentType: alert.instrumentType ?? 'CE',
    strike: alert.strike,
    expiry: alert.expiry ? new Date(alert.expiry) : new Date(),
    side: alert.action as 'BUY' | 'SELL',
    quantity: alert.quantity ?? 25, // Default 1 lot
    orderType: alert.orderType ?? 'MARKET',
    limitPrice: alert.limitPrice ? new Decimal(alert.limitPrice) : undefined,
    strategyId: alert.strategyId,
  };

  const fillEngine = getFillEngine();
  const order = await fillEngine.submitOrder(orderRequest);

  if (order.status === 'FILLED') {
    const positionManager = getPositionManager();
    positionManager.processOrderFill(order);
  }

  return {
    success: true,
    data: {
      orderId: order.id,
      status: order.status,
      avgFillPrice: order.avgFillPrice?.toString(),
    },
    timestamp: new Date(),
  };
}

async function closePosition(alert: TradingViewAlert): Promise<ApiResponse<unknown>> {
  const positionManager = getPositionManager();
  const position = alert.symbol
    ? positionManager.getPositionBySymbol(alert.symbol)
    : undefined;

  if (!position) {
    return {
      success: false,
      error: 'Position not found',
      timestamp: new Date(),
    };
  }

  const fillEngine = getFillEngine();
  const order = await fillEngine.submitOrder({
    symbol: position.symbol,
    underlying: position.underlying,
    instrumentType: position.instrumentType,
    strike: position.strike,
    expiry: position.expiry,
    side: position.side === 'LONG' ? 'SELL' : 'BUY',
    quantity: position.quantity,
    orderType: 'MARKET',
  });

  if (order.status === 'FILLED') {
    positionManager.processOrderFill(order);
  }

  return {
    success: true,
    data: {
      orderId: order.id,
      status: order.status,
      realizedPnL: position.realizedPnL.toString(),
    },
    timestamp: new Date(),
  };
}

// ============================================================================
// SERVER START
// ============================================================================

export function startWebhookServer(): void {
  const config = loadConfig();

  if (!config.webhook.enabled) {
    logger.info('Webhook server disabled');
    return;
  }

  const port = config.webhook.port;

  app.listen(port, () => {
    logger.info(`Webhook server listening on port ${port}`);
  });
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  loadConfig();
  startWebhookServer();
}

export { app };
