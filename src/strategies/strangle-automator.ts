import { InstrumentManager } from '../market-data/instrument-manager.js';
import { MarketStateManager } from '../market-data/market-state.js';
import { FillEngine } from '../execution/fill-engine.js';
import { PositionManager } from '../position/position-manager.js';
import { StrategyAggregator } from '../position/strategy-aggregator.js';
import { Underlying, Instrument } from '../core/types.js';
import { formatExpiry } from '../utils/date.js';
import chalk from 'chalk';

interface StrangleCandidate {
  ce: Instrument;
  pe: Instrument;
  ceLtp: number;
  peLtp: number;
  targetPremium: number;
  expiry: Date;
}

export class StrangleAutomator {
  constructor(
    private instrumentManager: InstrumentManager,
    private marketState: MarketStateManager,
    private fillEngine: FillEngine,
    private positionManager: PositionManager,
    private strategyAggregator: StrategyAggregator
  ) {}

  public findBestStrangle(underlying: Underlying, referenceCapital: number = 100000): StrangleCandidate | null {
    const expiries = this.instrumentManager.getAvailableExpiries(underlying);
    if (expiries.length === 0) { console.log(chalk.red('❌ No expiries found.')); return null; }
    
    // Select nearest expiry
    const expiry = expiries[0];
    
    // 3% Rule Calculation
    const lotSize = this.instrumentManager.getLotSize(underlying);
    const threePercent = referenceCapital * 0.03;
    const targetPremiumPerLeg = (threePercent / lotSize) / 2;

    const chain = this.instrumentManager.getOptionChain(underlying, expiry);
    if (!chain) return null;

    let bestCE: Instrument | null = null, bestPE: Instrument | null = null;
    let minDiffCE = Infinity, minDiffPE = Infinity;
    let foundCeLtp = 0, foundPeLtp = 0;

    for (const [strike, entry] of chain.strikes) {
      if (entry.ce) {
        const ltp = this.marketState.getLTP(entry.ce.instrumentToken);
        // SKIP IF PRICE IS ZERO (No Data Yet)
        if (ltp > 0) {
            const diff = Math.abs(ltp - targetPremiumPerLeg);
            if (diff < minDiffCE) { minDiffCE = diff; bestCE = entry.ce; foundCeLtp = ltp; }
        }
      }
      if (entry.pe) {
        const ltp = this.marketState.getLTP(entry.pe.instrumentToken);
        // SKIP IF PRICE IS ZERO
        if (ltp > 0) {
            const diff = Math.abs(ltp - targetPremiumPerLeg);
            if (diff < minDiffPE) { minDiffPE = diff; bestPE = entry.pe; foundPeLtp = ltp; }
        }
      }
    }

    // Safety: Ensure we found valid instruments with non-zero prices
    if (!bestCE || !bestPE || foundCeLtp === 0 || foundPeLtp === 0) {
        return null;
    }

    return { ce: bestCE, pe: bestPE, ceLtp: foundCeLtp, peLtp: foundPeLtp, targetPremium: targetPremiumPerLeg, expiry };
  }

  public async executeStrangle(candidate: StrangleCandidate, underlying: Underlying) {
    // 1. Double check prices are valid
    if (candidate.ceLtp <= 0 || candidate.peLtp <= 0) {
        console.log(chalk.red('❌ Aborting: Market data is zero/invalid. Wait for ticks.'));
        return;
    }

    try {
      console.log(chalk.yellow('🚀 Executing Strangle...'));
      
      // 2. Create Strategy Container (Now allowed to be empty initially)
      const strategyName = `Strangle ${formatExpiry(candidate.expiry)} ${new Date().toLocaleTimeString()}`;
      const ceStrike = candidate.ce.strike ?? 0;
      const peStrike = candidate.pe.strike ?? 0;
      const strategy = this.strategyAggregator.createStrategy(
        strategyName, 'SHORT_STRANGLE', underlying, candidate.expiry,
        (ceStrike + peStrike) / 2, 1
      );

      const qty = candidate.ce.lotSize; 
      const legs = [{ type: 'CE', inst: candidate.ce }, { type: 'PE', inst: candidate.pe }];

      // 3. Place Orders & Link
      for (const leg of legs) {
        const order = await this.fillEngine.submitOrder({
          symbol: leg.inst.tradingSymbol,
          underlying: leg.inst.underlying ?? underlying,
          instrumentType: leg.type as 'CE' | 'PE',
          strike: leg.inst.strike ?? 0,
          expiry: candidate.expiry,
          side: 'SELL',
          quantity: qty,
          orderType: 'MARKET'
        });
        
        if (order.status === 'FILLED') {
           const position = this.positionManager.processOrderFill(order);
           // Link the new position to our strategy
           this.strategyAggregator.linkPosition(strategy.id, position.id);
           console.log(chalk.green(`   ✓ Sold ${leg.type} ${leg.inst.strike}`));
        }
      }
    } catch (error: any) { 
        console.error(chalk.red('Execution Failed:'), error.message); 
    }
  }
}