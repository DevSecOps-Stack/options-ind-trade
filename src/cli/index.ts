/**
 * CLI Interface for NSE Options Paper Trading
 *
 * Interactive command-line interface for manual order placement
 * and portfolio monitoring.
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import chalk from 'chalk';
import Decimal from 'decimal.js';
import { KiteConnect } from 'kiteconnect';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { formatINR, formatWithSign } from '../utils/decimal.js';
import { formatExpiry, isMarketOpen, formatIST } from '../utils/date.js';
import { getKiteWebSocket } from '../market-data/kite-websocket.js';
import { getMarketState } from '../market-data/market-state.js';
import { getInstrumentManager } from '../market-data/instrument-manager.js';
import { getSpotTracker } from '../market-data/spot-tracker.js';
import { getFillEngine } from '../execution/fill-engine.js';
import { getPositionManager } from '../position/position-manager.js';
import { getStrategyAggregator } from '../position/strategy-aggregator.js';
import { getMarginTracker } from '../risk/margin-tracker.js';
import { getKillSwitch } from '../risk/kill-switch.js';
import { LOT_SIZES, STRATEGY_TEMPLATES } from '../core/constants.js';
import type { Underlying, StrategyType, OrderRequest } from '../core/types.js';

// ============================================================================
// CLI SETUP
// ============================================================================

const program = new Command();

program
  .name('nse-paper-trading')
  .description('NSE Options Paper Trading System')
  .version('1.0.0');

// ============================================================================
// COMMANDS
// ============================================================================

program
  .command('start')
  .description('Start the paper trading system')
  .action(async () => {
    console.log(chalk.green('Starting NSE Options Paper Trading System...'));

    try {
      const config = loadConfig();

      // Initialize Kite Connect
      const kite = new KiteConnect({ api_key: config.zerodha.apiKey });
      kite.setAccessToken(config.zerodha.accessToken);

      // Load instruments
      const instrumentManager = getInstrumentManager(kite);
      await instrumentManager.loadInstruments();
      console.log(chalk.green('✓ Instruments loaded'));

      // Initialize margin tracker
      const marginTracker = getMarginTracker(config.risk.initialCapital);
      console.log(chalk.green(`✓ Capital: ${formatINR(new Decimal(config.risk.initialCapital))}`));

      // Connect WebSocket
      const ws = getKiteWebSocket(kite, config.zerodha.apiKey, config.zerodha.accessToken);
      await ws.connect();
      console.log(chalk.green('✓ WebSocket connected'));

      // Auto-subscribe to option chains
      await ws.autoSubscribe(
        config.trading.underlyings as Underlying[],
        config.trading.strikesAroundATM
      );
      console.log(chalk.green('✓ Subscribed to option chains'));

      console.log(chalk.cyan('\nSystem ready. Use interactive mode for trading.'));
      console.log(chalk.gray('Press Ctrl+C to exit.\n'));

      // Start interactive loop
      await interactiveLoop();
    } catch (error) {
      console.error(chalk.red('Failed to start:'), error);
      process.exit(1);
    }
  });

program
  .command('positions')
  .description('Display current positions')
  .action(() => {
    displayPositions();
  });

program
  .command('orders')
  .description('Display pending orders')
  .action(() => {
    displayOrders();
  });

program
  .command('pnl')
  .description('Display P&L summary')
  .action(() => {
    displayPnL();
  });

program
  .command('margin')
  .description('Display margin status')
  .action(() => {
    displayMargin();
  });

program
  .command('chain <underlying>')
  .description('Display option chain for underlying')
  .action((underlying: string) => {
    displayOptionChain(underlying.toUpperCase() as Underlying);
  });

// ============================================================================
// INTERACTIVE MODE
// ============================================================================

async function interactiveLoop(): Promise<void> {
  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: '📊 View Positions', value: 'positions' },
          { name: '📈 View P&L', value: 'pnl' },
          { name: '💰 View Margin', value: 'margin' },
          { name: '🔗 View Option Chain', value: 'chain' },
          { name: '📝 Place Order', value: 'order' },
          { name: '📋 Create Strategy', value: 'strategy' },
          { name: '❌ Cancel Order', value: 'cancel' },
          { name: '🚪 Exit Position', value: 'exit' },
          { name: '⚠️  Kill Switch Status', value: 'killswitch' },
          { name: '🔄 Refresh', value: 'refresh' },
          { name: '👋 Quit', value: 'quit' },
        ],
      },
    ]);

    switch (action) {
      case 'positions':
        displayPositions();
        break;
      case 'pnl':
        displayPnL();
        break;
      case 'margin':
        displayMargin();
        break;
      case 'chain':
        await promptOptionChain();
        break;
      case 'order':
        await promptOrder();
        break;
      case 'strategy':
        await promptStrategy();
        break;
      case 'cancel':
        await promptCancelOrder();
        break;
      case 'exit':
        await promptExitPosition();
        break;
      case 'killswitch':
        displayKillSwitch();
        break;
      case 'refresh':
        refreshData();
        break;
      case 'quit':
        console.log(chalk.yellow('Goodbye!'));
        process.exit(0);
    }
  }
}

// ============================================================================
// DISPLAY FUNCTIONS
// ============================================================================

function displayPositions(): void {
  const positionManager = getPositionManager();
  const positions = positionManager.getAllPositions();

  if (positions.length === 0) {
    console.log(chalk.yellow('\nNo open positions.\n'));
    return;
  }

  const table = new Table({
    head: ['Symbol', 'Side', 'Qty', 'Avg Price', 'LTP', 'Unrealized P&L', 'Realized P&L'],
    colWidths: [25, 8, 8, 12, 12, 15, 15],
  });

  for (const pos of positions) {
    const unrealizedColor = pos.unrealizedPnL.isNegative() ? chalk.red : chalk.green;
    const realizedColor = pos.realizedPnL.isNegative() ? chalk.red : chalk.green;

    table.push([
      pos.symbol,
      pos.side === 'LONG' ? chalk.green('LONG') : chalk.red('SHORT'),
      pos.quantity,
      pos.avgPrice.toFixed(2),
      pos.currentPrice.toFixed(2),
      unrealizedColor(formatWithSign(pos.unrealizedPnL)),
      realizedColor(formatWithSign(pos.realizedPnL)),
    ]);
  }

  console.log('\n' + table.toString() + '\n');
}

function displayOrders(): void {
  const fillEngine = getFillEngine();
  const orders = fillEngine.getPendingOrders();

  if (orders.length === 0) {
    console.log(chalk.yellow('\nNo pending orders.\n'));
    return;
  }

  const table = new Table({
    head: ['ID', 'Symbol', 'Side', 'Qty', 'Type', 'Limit', 'Status', 'Created'],
    colWidths: [10, 25, 8, 8, 10, 10, 12, 20],
  });

  for (const order of orders) {
    table.push([
      order.id.slice(0, 8),
      order.symbol,
      order.side === 'BUY' ? chalk.green('BUY') : chalk.red('SELL'),
      order.quantity,
      order.orderType,
      order.limitPrice?.toFixed(2) ?? '-',
      order.status,
      formatIST(order.createdAt, 'HH:mm:ss'),
    ]);
  }

  console.log('\n' + table.toString() + '\n');
}

function displayPnL(): void {
  const positionManager = getPositionManager();
  const { realized, unrealized, total, positionCount, tradeCount } = positionManager.getAggregatePnL();

  console.log('\n' + chalk.bold('=== P&L Summary ==='));
  console.log(`Realized P&L:   ${formatWithSign(realized)}`);
  console.log(`Unrealized P&L: ${formatWithSign(unrealized)}`);
  console.log(chalk.bold(`Total P&L:      ${formatWithSign(total)}`));
  console.log(`\nPositions: ${positionCount} | Trades: ${tradeCount}\n`);

  // Strategy P&L
  const strategyAggregator = getStrategyAggregator();
  const strategies = strategyAggregator.getOpenStrategies();

  if (strategies.length > 0) {
    console.log(chalk.bold('=== Strategy P&L ==='));
    for (const strategy of strategies) {
      const totalColor = strategy.totalPnL.isNegative() ? chalk.red : chalk.green;
      console.log(`${strategy.name} (${strategy.type}): ${totalColor(formatWithSign(strategy.totalPnL))}`);
    }
    console.log();
  }
}

function displayMargin(): void {
  const marginTracker = getMarginTracker();
  const state = marginTracker.getState();

  const utilizationColor = state.marginUtilization.greaterThan(0.8) ? chalk.red :
                          state.marginUtilization.greaterThan(0.6) ? chalk.yellow : chalk.green;

  console.log('\n' + chalk.bold('=== Margin Status ==='));
  console.log(`Initial Capital:  ${formatINR(state.initialCapital)}`);
  console.log(`Used Margin:      ${formatINR(state.usedMargin)}`);
  console.log(`Available Margin: ${formatINR(state.availableMargin)}`);
  console.log(`Pending Orders:   ${formatINR(state.pendingOrderMargin)}`);
  console.log(`Utilization:      ${utilizationColor(state.marginUtilization.times(100).toFixed(2) + '%')}`);
  console.log(`MTM P&L:          ${formatWithSign(state.mtmPnL)}`);
  console.log(`Net Liquidation:  ${formatINR(state.netLiquidation)}\n`);
}

function displayOptionChain(underlying: Underlying): void {
  const marketState = getMarketState();
  const spotPrice = marketState.getSpotPrice(underlying);

  console.log(`\n${chalk.bold(underlying)} Option Chain | Spot: ${spotPrice.toFixed(2)}`);
  console.log(chalk.gray('─'.repeat(70)));

  const options = marketState.getOptionStates(underlying);

  // Group by strike
  const byStrike = new Map<number, { ce?: typeof options[0]; pe?: typeof options[0] }>();
  for (const opt of options) {
    if (!opt.strike) continue;
    const entry = byStrike.get(opt.strike) ?? {};
    if (opt.instrumentType === 'CE') entry.ce = opt;
    if (opt.instrumentType === 'PE') entry.pe = opt;
    byStrike.set(opt.strike, entry);
  }

  const strikes = Array.from(byStrike.keys()).sort((a, b) => a - b);
  const atmStrike = strikes.reduce((closest, strike) =>
    Math.abs(strike - spotPrice.toNumber()) < Math.abs(closest - spotPrice.toNumber()) ? strike : closest
  , strikes[0] ?? 0);

  const table = new Table({
    head: ['CE IV', 'CE LTP', 'CE Bid', 'CE Ask', 'Strike', 'PE Bid', 'PE Ask', 'PE LTP', 'PE IV'],
    colWidths: [8, 10, 10, 10, 10, 10, 10, 10, 8],
  });

  for (const strike of strikes) {
    const { ce, pe } = byStrike.get(strike) ?? {};
    const isATM = strike === atmStrike;
    const strikeStr = isATM ? chalk.yellow.bold(strike.toString()) : strike.toString();

    table.push([
      ce?.iv?.toFixed(1) ?? '-',
      ce?.ltp.toFixed(2) ?? '-',
      ce?.bid.toFixed(2) ?? '-',
      ce?.ask.toFixed(2) ?? '-',
      strikeStr,
      pe?.bid.toFixed(2) ?? '-',
      pe?.ask.toFixed(2) ?? '-',
      pe?.ltp.toFixed(2) ?? '-',
      pe?.iv?.toFixed(1) ?? '-',
    ]);
  }

  console.log(table.toString() + '\n');
}

function displayKillSwitch(): void {
  const killSwitch = getKillSwitch();
  const status = killSwitch.getStatus();

  console.log('\n' + chalk.bold('=== Kill Switch Status ==='));

  if (status.triggered) {
    console.log(chalk.red.bold('⚠️  KILL SWITCH ACTIVE'));
    console.log(`Reason: ${status.reason}`);
    console.log(`Triggered at: ${status.triggeredAt?.toISOString()}`);
  } else {
    console.log(chalk.green('✓ Kill switch not triggered'));
  }

  console.log(`\nDaily P&L: ${formatWithSign(status.dailyPnL)}`);
  console.log(`Peak P&L: ${formatWithSign(status.peakPnL)}`);
  console.log(`Trough P&L: ${formatWithSign(status.troughPnL)}`);
  console.log(`Max Drawdown: ${formatINR(status.maxDrawdown)}`);
  console.log(`\nMax Loss Limit: ${formatINR(status.config.maxDailyLoss)}`);
  console.log(`Margin Breach Threshold: ${status.config.marginBreachThreshold.times(100).toFixed(0)}%\n`);
}

function refreshData(): void {
  const positionManager = getPositionManager();
  positionManager.updateMarketPrices();
  console.log(chalk.green('✓ Data refreshed\n'));
}

// ============================================================================
// PROMPT FUNCTIONS
// ============================================================================

async function promptOptionChain(): Promise<void> {
  const { underlying } = await inquirer.prompt([
    {
      type: 'list',
      name: 'underlying',
      message: 'Select underlying:',
      choices: ['NIFTY', 'BANKNIFTY', 'FINNIFTY'],
    },
  ]);

  displayOptionChain(underlying);
}

async function promptOrder(): Promise<void> {
  const marketState = getMarketState();

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'underlying',
      message: 'Underlying:',
      choices: ['NIFTY', 'BANKNIFTY', 'FINNIFTY'],
    },
    {
      type: 'list',
      name: 'instrumentType',
      message: 'Instrument type:',
      choices: ['CE', 'PE'],
    },
    {
      type: 'input',
      name: 'strike',
      message: 'Strike price:',
      validate: (input: string) => !isNaN(Number(input)) || 'Enter a valid number',
    },
    {
      type: 'list',
      name: 'side',
      message: 'Side:',
      choices: ['BUY', 'SELL'],
    },
    {
      type: 'input',
      name: 'lots',
      message: 'Number of lots:',
      default: '1',
      validate: (input: string) => !isNaN(Number(input)) && Number(input) > 0 || 'Enter a valid number',
    },
    {
      type: 'list',
      name: 'orderType',
      message: 'Order type:',
      choices: ['MARKET', 'LIMIT'],
    },
    {
      type: 'input',
      name: 'limitPrice',
      message: 'Limit price:',
      when: (answers) => answers.orderType === 'LIMIT',
      validate: (input: string) => !isNaN(Number(input)) || 'Enter a valid number',
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Place this order?',
      default: true,
    },
  ]);

  if (!answers.confirm) {
    console.log(chalk.yellow('Order cancelled.\n'));
    return;
  }

  const underlying = answers.underlying as Underlying;
  const lotSize = LOT_SIZES[underlying];
  const quantity = parseInt(answers.lots) * lotSize;

  const orderRequest: OrderRequest = {
    symbol: `${underlying}${answers.strike}${answers.instrumentType}`,
    underlying,
    instrumentType: answers.instrumentType,
    strike: parseInt(answers.strike),
    expiry: new Date(), // TODO: Get from instrument manager
    side: answers.side,
    quantity,
    orderType: answers.orderType,
    limitPrice: answers.limitPrice ? new Decimal(answers.limitPrice) : undefined,
  };

  try {
    const fillEngine = getFillEngine();
    const order = await fillEngine.submitOrder(orderRequest);
    console.log(chalk.green(`✓ Order placed: ${order.id.slice(0, 8)}`));

    if (order.status === 'FILLED') {
      console.log(chalk.green(`  Filled at ${order.avgFillPrice?.toFixed(2)}`));

      const positionManager = getPositionManager();
      positionManager.processOrderFill(order);
    }
  } catch (error) {
    console.error(chalk.red('Order failed:'), error);
  }

  console.log();
}

async function promptStrategy(): Promise<void> {
  const marketState = getMarketState();

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'underlying',
      message: 'Underlying:',
      choices: ['NIFTY', 'BANKNIFTY', 'FINNIFTY'],
    },
    {
      type: 'list',
      name: 'strategyType',
      message: 'Strategy type:',
      choices: Object.keys(STRATEGY_TEMPLATES),
    },
    {
      type: 'input',
      name: 'atmStrike',
      message: 'ATM Strike (leave empty for current spot):',
    },
    {
      type: 'input',
      name: 'lots',
      message: 'Number of lots:',
      default: '1',
    },
    {
      type: 'input',
      name: 'name',
      message: 'Strategy name:',
      default: (answers: { strategyType: string }) => `${answers.strategyType} ${new Date().toLocaleDateString()}`,
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Create this strategy?',
      default: true,
    },
  ]);

  if (!answers.confirm) {
    console.log(chalk.yellow('Strategy creation cancelled.\n'));
    return;
  }

  const underlying = answers.underlying as Underlying;
  const spotPrice = marketState.getSpotPrice(underlying);
  const atmStrike = answers.atmStrike ? parseInt(answers.atmStrike) : Math.round(spotPrice.toNumber() / 100) * 100;

  try {
    const strategyAggregator = getStrategyAggregator();
    const strategy = strategyAggregator.createStrategy(
      answers.name,
      answers.strategyType as StrategyType,
      underlying,
      new Date(), // TODO: Get expiry
      atmStrike,
      parseInt(answers.lots)
    );

    console.log(chalk.green(`✓ Strategy created: ${strategy.id.slice(0, 8)}`));

    // Generate and place orders
    const orderRequests = strategyAggregator.generateOrderRequests(strategy.id);
    console.log(`  ${orderRequests.length} legs to be placed`);

    const { placeOrders } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'placeOrders',
        message: 'Place all leg orders now?',
        default: true,
      },
    ]);

    if (placeOrders) {
      const fillEngine = getFillEngine();
      const positionManager = getPositionManager();

      for (const request of orderRequests) {
        const order = await fillEngine.submitOrder(request);
        if (order.status === 'FILLED') {
          const position = positionManager.processOrderFill(order);
          strategyAggregator.linkPosition(strategy.id, position.id);
        }
      }
      console.log(chalk.green(`✓ All legs placed`));
    }
  } catch (error) {
    console.error(chalk.red('Strategy creation failed:'), error);
  }

  console.log();
}

async function promptCancelOrder(): Promise<void> {
  const fillEngine = getFillEngine();
  const orders = fillEngine.getPendingOrders();

  if (orders.length === 0) {
    console.log(chalk.yellow('No pending orders to cancel.\n'));
    return;
  }

  const { orderId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'orderId',
      message: 'Select order to cancel:',
      choices: orders.map(o => ({
        name: `${o.id.slice(0, 8)} | ${o.symbol} | ${o.side} ${o.quantity}`,
        value: o.id,
      })),
    },
  ]);

  const cancelled = fillEngine.cancelOrder(orderId);
  if (cancelled) {
    console.log(chalk.green(`✓ Order cancelled: ${orderId.slice(0, 8)}\n`));
  } else {
    console.log(chalk.red('Failed to cancel order.\n'));
  }
}

async function promptExitPosition(): Promise<void> {
  const positionManager = getPositionManager();
  const positions = positionManager.getAllPositions();

  if (positions.length === 0) {
    console.log(chalk.yellow('No positions to exit.\n'));
    return;
  }

  const { positionId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'positionId',
      message: 'Select position to exit:',
      choices: positions.map(p => ({
        name: `${p.symbol} | ${p.side} ${p.quantity} @ ${p.avgPrice.toFixed(2)} | P&L: ${formatWithSign(p.unrealizedPnL)}`,
        value: p.id,
      })),
    },
  ]);

  const position = positionManager.getPosition(positionId);
  if (!position) return;

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Exit ${position.quantity} ${position.symbol}?`,
      default: true,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('Exit cancelled.\n'));
    return;
  }

  try {
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
      console.log(chalk.green(`✓ Position exited at ${order.avgFillPrice?.toFixed(2)}\n`));
    }
  } catch (error) {
    console.error(chalk.red('Exit failed:'), error);
  }
}

// ============================================================================
// MAIN
// ============================================================================

export async function runCLI(): Promise<void> {
  program.parse();
}

// Run if executed directly
runCLI().catch(console.error);
