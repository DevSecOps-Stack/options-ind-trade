import { Strategy, StrategyType, Underlying, Position, StrategyStatus } from '../core/types.js';
import { v4 as uuidv4 } from 'uuid';

export class StrategyAggregator {
  private strategies: Map<string, Strategy> = new Map();
  // Map Position ID -> Strategy ID
  private positionMap: Map<string, string> = new Map();

  createStrategy(
    name: string,
    type: StrategyType,
    underlying: Underlying,
    expiry: Date,
    strike: number,
    lotSize: number
  ): Strategy {
    const strategy: Strategy = {
      id: uuidv4(),
      name,
      type,
      underlying,
      expiry,
      strike,
      lotSize,
      status: 'ACTIVE', // Default to ACTIVE
      createdAt: new Date(),
      positionIds: [],  // Start empty
      totalPnL: new (require('decimal.js').Decimal)(0),
      legs: []
    };

    this.strategies.set(strategy.id, strategy);
    return strategy;
  }

  linkPosition(strategyId: string, positionId: string): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) throw new Error('Strategy not found');

    if (!strategy.positionIds.includes(positionId)) {
      strategy.positionIds.push(positionId);
      this.positionMap.set(positionId, strategyId);
    }
  }

  getStrategy(id: string): Strategy | undefined {
    return this.strategies.get(id);
  }

  getOpenStrategies(): Strategy[] {
    return Array.from(this.strategies.values()).filter(s => s.status === 'ACTIVE');
  }

  getStrategyForPosition(positionId: string): Strategy | undefined {
    const stratId = this.positionMap.get(positionId);
    return stratId ? this.strategies.get(stratId) : undefined;
  }
}

// Singleton
let instance: StrategyAggregator | null = null;
export function getStrategyAggregator(): StrategyAggregator {
  if (!instance) instance = new StrategyAggregator();
  return instance;
}