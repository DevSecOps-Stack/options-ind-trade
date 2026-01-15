import { Strategy, StrategyType, Underlying } from '../core/types.js';
import { v4 as uuidv4 } from 'uuid';
import { Decimal, ZERO } from '../utils/decimal.js';

export class StrategyAggregator {
  private strategies: Map<string, Strategy> = new Map();
  // Map Position ID -> Strategy ID
  private positionMap: Map<string, string> = new Map();

  createStrategy(
    name: string,
    type: StrategyType,
    underlying: Underlying,
    expiry: Date,
    atmStrike: number,
    lots: number
  ): Strategy {
    const strategy: Strategy = {
      id: uuidv4(),
      name,
      type,
      underlying,
      expiry,
      atmStrike,
      legs: [],
      positions: [],
      status: 'OPEN',
      entryTime: new Date(),
      realizedPnL: ZERO,
      unrealizedPnL: ZERO,
      totalPnL: ZERO,
      breakevens: [],
      margin: ZERO,
      lotSize: 0,
      lots
    };

    this.strategies.set(strategy.id, strategy);
    return strategy;
  }

  linkPosition(strategyId: string, positionId: string): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) throw new Error('Strategy not found');

    if (!strategy.positions.includes(positionId)) {
      strategy.positions.push(positionId);
      this.positionMap.set(positionId, strategyId);
    }
  }

  getStrategy(id: string): Strategy | undefined {
    return this.strategies.get(id);
  }

  getOpenStrategies(): Strategy[] {
    return Array.from(this.strategies.values()).filter(s => s.status === 'OPEN');
  }

  getStrategyForPosition(positionId: string): Strategy | undefined {
    const stratId = this.positionMap.get(positionId);
    return stratId ? this.strategies.get(stratId) : undefined;
  }
}

// Singleton
let instance: StrategyAggregator | null = null;

export function getStrategyAggregator(): StrategyAggregator {
  if (!instance) {
    instance = new StrategyAggregator();
  }
  return instance;
}

export function resetStrategyAggregator(): void {
  instance = null;
}
