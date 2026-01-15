/**
 * CLI Interface for NSE Options Paper Trading
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import chalk from 'chalk';
import { KiteConnect } from 'kiteconnect';
type KiteInstance = InstanceType<typeof KiteConnect>;
import { loadConfig } from '../config/index.js';
import { formatINR } from '../utils/decimal.js';
import { getKiteWebSocket } from '../market-data/kite-websocket.js';
import { getMarketState } from '../market-data/market-state.js';
import { getInstrumentManager } from '../market-data/instrument-manager.js';
import { getFillEngine } from '../execution/fill-engine.js';
import { getPositionManager } from '../position/position-manager.js';
import { getStrategyAggregator } from '../position/strategy-aggregator.js';
import { getMarginTracker } from '../risk/margin-tracker.js';
import { TokenManager } from '../utils/token-manager.js';
import { TelegramTradingBot } from './telegram-bot.js';
import { RobustMonitor } from '../strategies/robust-monitor.js';
import { StrangleAutomator } from '../strategies/strangle-automator.js';
import type { Underlying } from '../core/types.js';

const program = new Command();

program
  .name('nse-paper-trading')
  .description('NSE Options Paper Trading System')
  .version('2.2.0');

program
  .command('start')
  .description('Start the system')
  .action(async () => {
    console.log(chalk.green('Starting NSE Options Paper Trading System...'));

    try {
      const config = loadConfig();
      const kite = new KiteConnect({ api_key: config.zerodha.apiKey });

      // Initialize Managers (cast kite to any due to type mismatch in kiteconnect package)
      const tokenManager = new TokenManager(kite as any, config.zerodha.apiKey, config.zerodha.apiSecret);
      const instrumentManager = getInstrumentManager(kite as any); // Singleton created here
      const positionManager = getPositionManager();
      const strategyAggregator = getStrategyAggregator();
      const fillEngine = getFillEngine();
      const marginTracker = getMarginTracker(config.risk.initialCapital);
      const marketState = getMarketState();
      const robustMonitor = new RobustMonitor(strategyAggregator, positionManager, fillEngine);

      // Try to Load Token
      let hasToken = await tokenManager.loadToken();

      // Start Telegram
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        new TelegramTradingBot(
          process.env.TELEGRAM_BOT_TOKEN,
          parseInt(process.env.TELEGRAM_CHAT_ID),
          tokenManager, instrumentManager, marketState, fillEngine,
          positionManager, strategyAggregator, robustMonitor
        );
        console.log(chalk.cyan('✓ Telegram Bot Active'));
      } else {
        console.log(chalk.yellow('⚠️ Telegram config missing.'));
      }

      // Login Logic
      if (!hasToken) {
        if (!process.env.TELEGRAM_BOT_TOKEN) {
            console.log(chalk.cyan('\n🔓 MANUAL LOGIN REQUIRED'));
            console.log('1. Login to: https://kite.trade/connect/login?api_key=' + config.zerodha.apiKey);
            const { reqToken } = await inquirer.prompt([{
                type: 'input', name: 'reqToken', message: '📋 Paste Request Token here:',
                validate: (input) => input.length > 5 || 'Invalid Token'
            }]);
            try {
                const username = await tokenManager.handleLogin(reqToken.trim());
                console.log(chalk.green(`✅ Login Successful! Welcome ${username}`));
                hasToken = true;
            } catch (error: any) {
                console.error(chalk.red(`❌ Login Failed: ${error.message}`));
                process.exit(1);
            }
        } else {
            console.log(chalk.gray('Waiting for /login via Telegram...'));
            // Wait for Telegram login with timeout check every 5 seconds
            while (!hasToken) {
              await new Promise(resolve => setTimeout(resolve, 5000));
              hasToken = await tokenManager.loadToken();
              if (hasToken) {
                console.log(chalk.green('✓ Token received via Telegram!'));
                break;
              }
            }
        }
      }

      if (hasToken) {
        console.log(chalk.green('✓ Access Token loaded'));
        
        // 1. Load Instruments
        await instrumentManager.loadInstruments();
        
        // --- DEBUG: Verify Instruments ---
        const allInsts = instrumentManager.getAllInstruments();
        console.log(chalk.magenta(`[DEBUG] Memory contains ${allInsts.length} instruments.`));
        if (allInsts.length === 0) {
            console.log(chalk.red('❌ CRITICAL: No instruments in memory!'));
            process.exit(1);
        }

        // 2. Connect WebSocket
        const liveToken = (kite as any).access_token as string || config.zerodha.accessToken;
        const ws = getKiteWebSocket(kite as any, config.zerodha.apiKey, liveToken);
        await ws.connect();
        console.log(chalk.green('✓ WebSocket connected'));
        
        // 3. MANUAL SUBSCRIPTION (Bypassing auto-logic to ensure it works)
        console.log(chalk.yellow('⏳ Calculating subscriptions...'));
        const tokensToSubscribe: number[] = [];
        const underlyings = config.trading.underlyings as Underlying[];
        
        for (const und of underlyings) {
            // Use the Robust method we added
            const tokens = instrumentManager.getSubscriptionTokens(und);
            console.log(chalk.gray(`   -> ${und}: Found ${tokens.length} tokens`));
            tokensToSubscribe.push(...tokens);
        }

        if (tokensToSubscribe.length > 0) {
            ws.subscribe(tokensToSubscribe);
            ws.setMode('full'); // Set to Full mode for LTP
            console.log(chalk.green(`✓ FORCE SUBSCRIBED to ${tokensToSubscribe.length} instruments.`));
        } else {
            console.log(chalk.red('❌ No tokens found to subscribe. Check Instrument Manager!'));
        }

        await robustMonitor.loadState();
        console.log(chalk.cyan('\nSystem Ready.'));
        await interactiveLoop();
      }

    } catch (error) {
      console.error(chalk.red('Failed to start:'), error);
      process.exit(1);
    }
  });

// ... (KEEP ALL FUNCTIONS BELOW THIS LINE EXACTLY AS THEY WERE) ...

async function interactiveLoop(): Promise<void> {
  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        pageSize: 12,
        choices: [
          new inquirer.Separator('--- TRADING ---'),
          { name: '🤖 Auto-Strangle 2.0', value: 'auto_strangle' },
          { name: '📝 Place Manual Order', value: 'order' },
          new inquirer.Separator('--- MONITORING ---'),
          { name: '📺 Live Dashboard', value: 'dashboard' },
          { name: '📊 View Positions', value: 'positions' },
          { name: '📈 View P&L', value: 'pnl' },
          new inquirer.Separator('--- SYSTEM ---'),
          { name: '👋 Quit', value: 'quit' },
        ],
      },
    ]);

    switch (action) {
      case 'dashboard': await startLiveDashboard(); break;
      case 'positions': displayPositions(); break;
      case 'pnl': displayPnL(); break;
      case 'auto_strangle': await promptAutoStrangle(); break;
      case 'order': await promptOrder(); break;
      case 'quit': process.exit(0);
    }
  }
}

async function promptAutoStrangle(): Promise<void> {
  const answers = await inquirer.prompt([
    { type: 'list', name: 'underlying', message: 'Select Underlying:', choices: ['NIFTY', 'BANKNIFTY'] },
    { type: 'input', name: 'capital', message: 'Capital:', default: '200000' }
  ]);
  
  const automator = new StrangleAutomator(
    getInstrumentManager({} as any), getMarketState(), getFillEngine(), 
    getPositionManager(), getStrategyAggregator()
  );

  console.log(chalk.yellow('\n🔍 Scanning...'));
  const candidate = automator.findBestStrangle(answers.underlying as any, parseFloat(answers.capital));
  
  if(!candidate) { console.log(chalk.red('No strikes found (Prices might be 0 or loading).')); return; }

  const ceLtp = Number(candidate.ceLtp) || 0;
  const peLtp = Number(candidate.peLtp) || 0;
  const totalPrem = ceLtp + peLtp;
  
  console.log(chalk.green(`\n🎯 Found: Sell ${candidate.ce.strike} CE & ${candidate.pe.strike} PE`));
  console.log(chalk.gray(`   Premium: ₹${totalPrem.toFixed(2)}`));
  
  const { confirm } = await inquirer.prompt([{ type: 'confirm', name: 'confirm', message: 'Execute?', default: true }]);
  if(confirm) {
     await automator.executeStrangle(candidate, answers.underlying as any);
     const strategies = getStrategyAggregator().getOpenStrategies();
     const last = strategies[strategies.length-1];
     if(last) new RobustMonitor(getStrategyAggregator(), getPositionManager(), getFillEngine()).startMonitoring(last.id, parseFloat(answers.capital));
  }
}

async function startLiveDashboard() {
  const pm = getPositionManager();
  process.stdout.write('\x1Bc');
  console.log(chalk.yellow('Starting Dashboard... (Press Ctrl+C to stop)'));
  
  const int = setInterval(() => {
     pm.updateMarketPrices();
     process.stdout.write('\x1Bc');
     const pnl = pm.getAggregatePnL();
     const color = pnl.total.isNegative() ? chalk.red : chalk.green;
     console.log(chalk.bold(`LIVE P&L: ${color(formatINR(pnl.total))}`));
     
     const positions = pm.getAllPositions();
     if(positions.length > 0) {
       console.log('\nPositions:');
       positions.forEach(p => console.log(`${p.symbol}: ${formatINR(p.unrealizedPnL)}`));
     }
     console.log(chalk.gray('\nPress Ctrl+C to exit dashboard'));
  }, 1000);

  await new Promise<void>((resolve) => {
    const onSigInt = () => {
        clearInterval(int);
        process.removeListener('SIGINT', onSigInt);
        resolve();
    };
    process.on('SIGINT', onSigInt);
  });
}

function displayPositions() { 
  const pm = getPositionManager();
  const pos = pm.getAllPositions();
  if(!pos.length) { console.log(chalk.yellow('No positions.')); return; }
  const t = new Table({ head: ['Symbol', 'Qty', 'P&L'] });
  pos.forEach(p => t.push([p.symbol, p.quantity, p.unrealizedPnL.toFixed(2)]));
  console.log(t.toString());
}

function displayPnL() {
  const pnl = getPositionManager().getAggregatePnL();
  console.log(chalk.bold(`Total P&L: ${formatINR(pnl.total)}`));
}

async function promptOrder() { 
   console.log(chalk.yellow('Use Auto-Strangle for best results.'));
}

export async function runCLI(args?: string[]) {
    await program.parseAsync(process.argv);
}
// Fix: Allow running from compiled JS in Docker
if (process.argv[1].includes('cli/index') || process.argv[1].includes('index.js')) {
    runCLI();
}