import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { StrategyAggregator } from '../position/strategy-aggregator.js';
import { PositionManager } from '../position/position-manager.js';
import { FillEngine } from '../execution/fill-engine.js';
import { formatINR } from '../utils/decimal.js';

const STATE_FILE = path.join(process.cwd(), 'data', 'active-strategies.json');

interface MonitoredStrategy {
  id: string;
  capital: number;
  target: number;
  stopLoss: number;
  startTime: number;
}

export class RobustMonitor {
  private activeStrategies: Map<string, MonitoredStrategy> = new Map();
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private aggregator: StrategyAggregator,
    private positionManager: PositionManager,
    private fillEngine: FillEngine
  ) {}

  /**
   * Load saved strategies from disk (Persist across restarts)
   */
  async loadState() {
    try {
      const data = await fs.readFile(STATE_FILE, 'utf-8');
      const strategies = JSON.parse(data);
      strategies.forEach((s: MonitoredStrategy) => this.activeStrategies.set(s.id, s));
      
      if (this.activeStrategies.size > 0) {
          console.log(chalk.cyan(`🛡️ Restored ${this.activeStrategies.size} active strategies.`));
          this.startLoop();
      }
    } catch (e) {
      // File doesn't exist yet, which is fine
    }
  }

  async saveState() {
    try {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      await fs.writeFile(STATE_FILE, JSON.stringify(Array.from(this.activeStrategies.values()), null, 2));
    } catch (e) {
      console.error('Failed to save monitor state', e);
    }
  }

  /**
   * Start watching a new strategy
   */
  async startMonitoring(strategyId: string, capital: number) {
    this.activeStrategies.set(strategyId, {
      id: strategyId,
      capital,
      target: capital * 0.005, // 0.5% Target
      stopLoss: capital * 0.01, // 1.0% Stop Loss
      startTime: Date.now()
    });
    await this.saveState();
    this.startLoop();
    console.log(chalk.magenta(`🛡️ Monitor attached to ${strategyId.slice(0,8)}. Target: 0.5% | SL: 1.0%`));
  }

  private startLoop() {
    if (this.interval) return;
    
    this.interval = setInterval(async () => {
      if (this.activeStrategies.size === 0) {
          clearInterval(this.interval!);
          this.interval = null;
          return;
      }

      for (const [id, config] of this.activeStrategies) {
        const strat = this.aggregator.getStrategy(id);
        
        // If strategy was manually closed, remove from monitor
        if (!strat || strat.positions.length === 0) {
            this.activeStrategies.delete(id);
            continue;
        }

        // Check P&L
        const pnl = strat.totalPnL.toNumber();
        
        // Condition A: Target Hit
        if (pnl >= config.target) {
          console.log(chalk.green(`\n🎯 TARGET HIT on ${strat.name}! P&L: ${formatINR(pnl)}`));
          await this.exitStrategy(id);
        } 
        // Condition B: Stop Loss Hit
        else if (pnl <= -config.stopLoss) {
          console.log(chalk.red(`\n🚨 STOP LOSS HIT on ${strat.name}! P&L: ${formatINR(pnl)}`));
          await this.exitStrategy(id);
        }
      }
    }, 2000); // Check every 2 seconds
  }

  private async exitStrategy(id: string) {
    const strat = this.aggregator.getStrategy(id);
    if (!strat) return;

    console.log(chalk.yellow(`📉 Exiting Strategy: ${strat.name}...`));
    
    // Close all positions in this strategy
    for (const posId of strat.positions) {
        const pos = this.positionManager.getPosition(posId);
        if (pos) {
            await this.fillEngine.submitOrder({
                symbol: pos.symbol,
                underlying: pos.underlying,
                instrumentType: pos.instrumentType,
                strike: pos.strike,
                expiry: pos.expiry,
                side: pos.side === 'LONG' ? 'SELL' : 'BUY',
                quantity: pos.quantity,
                orderType: 'MARKET'
            });
        }
    }
    
    // Stop monitoring this strategy
    this.activeStrategies.delete(id);
    await this.saveState();
    console.log(chalk.green(`✓ Strategy Closed.`));
  }
}