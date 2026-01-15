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
    const allExpiries = this.instrumentManager.getAvailableExpiries(underlying);
    if (allExpiries.length === 0) { console.log(chalk.red('❌ No expiries found.')); return null; }
    
    // ============================================================
    // 📅 STRATEGY LOGIC: MONTHLY ROLLOVER
    // ============================================================
    const today = new Date();
    const currentDay = today.getDate(); // 1 to 31
    let targetMonth = today.getMonth(); // 0 = Jan, 11 = Dec
    let targetYear = today.getFullYear();

    // RULE: If today is the 15th or later (Week 3 & 4), trade NEXT Month.
    //       If today is before the 15th (Week 1 & 2), trade CURRENT Month.
    if (currentDay >= 15) {
        targetMonth++; 
        // Handle Year Rollover (If Dec -> Switch to Jan of Next Year)
        if (targetMonth > 11) {
            targetMonth = 0;
            targetYear++;
        }
        console.log(chalk.magenta(`📅 Second half of month. Switching target to: ${targetMonth + 1}/${targetYear} (Next Month)`));
    } else {
        console.log(chalk.blue(`📅 First half of month. Staying with target: ${targetMonth + 1}/${targetYear} (Current Month)`));
    }

    // Helper: Find the Monthly Expiry (The last expiry of that specific month)
    const getMonthlyExpiry = (month: number, year: number): Date | undefined => {
        // Filter expiries that match the Target Month & Year
        const monthExpiries = allExpiries.filter(d => 
            d.getMonth() === month && d.getFullYear() === year
        );
        // The Monthly contract is always the LAST available expiry of that month
        return monthExpiries[monthExpiries.length - 1];
    };

    let selectedExpiry = getMonthlyExpiry(targetMonth, targetYear);

    // Fallback 1: If next month not found (illiquid?), fallback to nearest Monthly
    if (!selectedExpiry) {
        console.log(chalk.yellow('⚠️ Target monthly not found. Falling back to nearest available Monthly.'));
        selectedExpiry = getMonthlyExpiry(today.getMonth(), today.getFullYear());
    }
    
    // Fallback 2: If absolutely nothing matches, take the furthest available date
    if (!selectedExpiry) selectedExpiry = allExpiries[allExpiries.length - 1];

    console.log(chalk.cyan(`🎯 Selected Expiry: ${formatExpiry(selectedExpiry)}`));
    
    // ============================================================
    // 💰 PREMIUM LOGIC: 3% RULE
    // ============================================================
    const lotSize = this.instrumentManager.getLotSize(underlying);
    const threePercent = referenceCapital * 0.03;
    
    // We need 3% total premium. Divide by 2 legs (CE & PE).
    // Example: 200k Capital -> 6k Target -> 240 pts total -> 120 pts per leg.
    const targetPremiumPerLeg = (threePercent / lotSize) / 2;

    const chain = this.instrumentManager.getOptionChain(underlying, selectedExpiry);
    if (!chain) return null;

    let bestCE: Instrument | null = null, bestPE: Instrument | null = null;
    let minDiffCE = Infinity, minDiffPE = Infinity;
    let foundCeLtp = 0, foundPeLtp = 0;

    // Scan Option Chain for prices closest to targetPremiumPerLeg
    for (const [strike, entry] of chain.strikes) {
      if (entry.ce) {
        let ltp = this.marketState.getLTP(entry.ce.instrumentToken);
        
        // --- SIMULATION HACK: If Market is Closed (Price=0), use Target ---
        if (ltp === 0) ltp = targetPremiumPerLeg; 
        // -----------------------------------------------------------------

        const diff = Math.abs(ltp - targetPremiumPerLeg);
        if (diff < minDiffCE) { minDiffCE = diff; bestCE = entry.ce; foundCeLtp = ltp; }
      }
      if (entry.pe) {
        let ltp = this.marketState.getLTP(entry.pe.instrumentToken);
        
        // --- SIMULATION HACK: If Market is Closed (Price=0), use Target ---
        if (ltp === 0) ltp = targetPremiumPerLeg;
        // -----------------------------------------------------------------

        const diff = Math.abs(ltp - targetPremiumPerLeg);
        if (diff < minDiffPE) { minDiffPE = diff; bestPE = entry.pe; foundPeLtp = ltp; }
      }
    }

    if (!bestCE || !bestPE) return null;

    return { 
        ce: bestCE, 
        pe: bestPE, 
        ceLtp: foundCeLtp, 
        peLtp: foundPeLtp, 
        targetPremium: targetPremiumPerLeg, 
        expiry: selectedExpiry 
    };
  }

  public async executeStrangle(candidate: StrangleCandidate, underlying: Underlying) {
    try {
      console.log(chalk.yellow(`🚀 Executing Strangle for ${formatExpiry(candidate.expiry)}...`));
      
      const strategyName = `Strangle ${formatExpiry(candidate.expiry)} ${new Date().toLocaleTimeString()}`;
      const ceStrike = candidate.ce.strike ?? 0;
      const peStrike = candidate.pe.strike ?? 0;
      
      const strategy = this.strategyAggregator.createStrategy(
        strategyName, 'SHORT_STRANGLE', underlying, candidate.expiry,
        (ceStrike + peStrike) / 2, 1
      );

      const qty = candidate.ce.lotSize; 
      const legs = [{ type: 'CE', inst: candidate.ce }, { type: 'PE', inst: candidate.pe }];

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
           this.strategyAggregator.linkPosition(strategy.id, position.id);
           console.log(chalk.green(`   ✓ Sold ${leg.type} ${leg.inst.strike} @ ₹${position.avgPrice.toFixed(2)}`));
        }
      }
    } catch (error: any) { 
        console.error(chalk.red('Execution Failed:'), error.message); 
    }
  }
}