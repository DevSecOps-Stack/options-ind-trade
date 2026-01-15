import fs from 'fs';
import path from 'path';
import DecimalConstructor from 'decimal.js';
const Decimal = (DecimalConstructor as any).default || DecimalConstructor;
type Decimal = InstanceType<typeof Decimal>;
import { logger } from '../utils/logger.js';
import type { Position } from './types.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'portfolio.json');

interface PortfolioState {
  capital: string;
  positions: Position[];
  tradeHistory: any[]; // You can define a Trade type later
}

export class PersistenceManager {
  constructor() {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR);
    }
  }

  save(capital: Decimal, positions: Position[]) {
    const data: PortfolioState = {
      capital: capital.toString(),
      positions: positions,
      tradeHistory: [] // Placeholder for now
    };

    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
      logger.info('Portfolio saved to disk');
    } catch (error) {
      logger.error('Failed to save portfolio', { error });
    }
  }

  load(): { capital: Decimal, positions: Position[] } | null {
    if (!fs.existsSync(DATA_FILE)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      
      // Revive Decimal objects and Date objects
      const positions = data.positions.map((p: any) => ({
        ...p,
        avgPrice: new Decimal(p.avgPrice),
        currentPrice: new Decimal(p.currentPrice),
        unrealizedPnL: new Decimal(p.unrealizedPnL),
        realizedPnL: new Decimal(p.realizedPnL),
        expiry: new Date(p.expiry),
        createdAt: new Date(p.createdAt),
        updatedAt: new Date(p.updatedAt)
      }));

      return {
        capital: new Decimal(data.capital),
        positions: positions
      };
    } catch (error) {
      logger.error('Failed to load portfolio', { error });
      return null;
    }
  }
}

// Singleton
export const persistenceManager = new PersistenceManager();