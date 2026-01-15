/**
 * Trade Journal - Track all trades for learning and analysis
 *
 * Features:
 * - Auto-log every trade entry/exit
 * - Performance analytics (win rate, avg profit, etc.)
 * - Add notes to trades for learning
 * - Export trade history
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import type { Underlying } from '../core/types.js';

// Ensure data directory exists
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'trade_journal.db');

// ============================================================================
// TYPES
// ============================================================================

export interface TradeEntry {
  id?: number;
  tradeId: string;           // Unique trade identifier
  strategyType: 'SHORT_STRANGLE' | 'SHORT_STRADDLE' | 'IRON_CONDOR' | 'SINGLE_LEG';
  underlying: Underlying;

  // Entry details
  entryDate: string;         // ISO date
  entrySpot: number;
  ceStrike?: number;
  peStrike?: number;
  cePremium?: number;
  pePremium?: number;
  totalPremium: number;
  lots: number;
  marginUsed: number;

  // Exit details (null if still open)
  exitDate?: string;
  exitSpot?: number;
  ceExitPrice?: number;
  peExitPrice?: number;
  exitReason?: 'TARGET' | 'STOP_LOSS' | 'EXPIRY' | 'MANUAL' | 'ADJUSTMENT';

  // P&L
  realizedPnL?: number;
  maxDrawdown?: number;
  maxProfit?: number;

  // Greeks at entry
  entryDelta?: number;
  entryTheta?: number;
  entryVega?: number;
  entryIV?: number;

  // Learning
  notes?: string;
  lessons?: string;
  rating?: number;           // 1-5 self-rating

  // Status
  status: 'OPEN' | 'CLOSED' | 'ADJUSTED';
  daysHeld?: number;
}

export interface PerformanceStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;

  totalPnL: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number;      // Total wins / Total losses

  avgDaysHeld: number;
  avgROI: number;

  // By underlying
  niftyStats: { trades: number; pnl: number; winRate: number };
  bankniftyStats: { trades: number; pnl: number; winRate: number };

  // Recent performance
  last5Trades: TradeEntry[];
  currentStreak: number;     // Positive = winning, negative = losing
}

// ============================================================================
// DATABASE CLASS
// ============================================================================

export class TradeJournal {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initializeSchema();
    logger.info('Trade Journal initialized', { dbPath: DB_PATH });
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT UNIQUE NOT NULL,
        strategy_type TEXT NOT NULL,
        underlying TEXT NOT NULL,

        entry_date TEXT NOT NULL,
        entry_spot REAL NOT NULL,
        ce_strike REAL,
        pe_strike REAL,
        ce_premium REAL,
        pe_premium REAL,
        total_premium REAL NOT NULL,
        lots INTEGER NOT NULL,
        margin_used REAL NOT NULL,

        exit_date TEXT,
        exit_spot REAL,
        ce_exit_price REAL,
        pe_exit_price REAL,
        exit_reason TEXT,

        realized_pnl REAL,
        max_drawdown REAL,
        max_profit REAL,

        entry_delta REAL,
        entry_theta REAL,
        entry_vega REAL,
        entry_iv REAL,

        notes TEXT,
        lessons TEXT,
        rating INTEGER,

        status TEXT NOT NULL DEFAULT 'OPEN',
        days_held INTEGER,

        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_trades_underlying ON trades(underlying);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_entry_date ON trades(entry_date);
    `);
  }

  // ============================================================================
  // CRUD OPERATIONS
  // ============================================================================

  /**
   * Log a new trade entry
   */
  logEntry(trade: Omit<TradeEntry, 'id' | 'status'>): TradeEntry {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        trade_id, strategy_type, underlying,
        entry_date, entry_spot, ce_strike, pe_strike,
        ce_premium, pe_premium, total_premium, lots, margin_used,
        entry_delta, entry_theta, entry_vega, entry_iv,
        notes, status
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, 'OPEN'
      )
    `);

    const result = stmt.run(
      trade.tradeId, trade.strategyType, trade.underlying,
      trade.entryDate, trade.entrySpot, trade.ceStrike, trade.peStrike,
      trade.cePremium, trade.pePremium, trade.totalPremium, trade.lots, trade.marginUsed,
      trade.entryDelta, trade.entryTheta, trade.entryVega, trade.entryIV,
      trade.notes
    );

    logger.info('Trade entry logged', { tradeId: trade.tradeId, underlying: trade.underlying });

    return { ...trade, id: result.lastInsertRowid as number, status: 'OPEN' };
  }

  /**
   * Log trade exit
   */
  logExit(
    tradeId: string,
    exitData: {
      exitDate: string;
      exitSpot: number;
      ceExitPrice?: number;
      peExitPrice?: number;
      exitReason: TradeEntry['exitReason'];
      realizedPnL: number;
      maxDrawdown?: number;
      maxProfit?: number;
    }
  ): void {
    const trade = this.getTradeById(tradeId);
    if (!trade) {
      logger.warn('Trade not found for exit', { tradeId });
      return;
    }

    const entryDate = new Date(trade.entryDate);
    const exitDate = new Date(exitData.exitDate);
    const daysHeld = Math.ceil((exitDate.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));

    const stmt = this.db.prepare(`
      UPDATE trades SET
        exit_date = ?,
        exit_spot = ?,
        ce_exit_price = ?,
        pe_exit_price = ?,
        exit_reason = ?,
        realized_pnl = ?,
        max_drawdown = ?,
        max_profit = ?,
        days_held = ?,
        status = 'CLOSED',
        updated_at = CURRENT_TIMESTAMP
      WHERE trade_id = ?
    `);

    stmt.run(
      exitData.exitDate,
      exitData.exitSpot,
      exitData.ceExitPrice,
      exitData.peExitPrice,
      exitData.exitReason,
      exitData.realizedPnL,
      exitData.maxDrawdown,
      exitData.maxProfit,
      daysHeld,
      tradeId
    );

    logger.info('Trade exit logged', { tradeId, pnl: exitData.realizedPnL, daysHeld });
  }

  /**
   * Add notes to a trade
   */
  addNotes(tradeId: string, notes: string, lessons?: string, rating?: number): void {
    const stmt = this.db.prepare(`
      UPDATE trades SET
        notes = COALESCE(notes || '\n', '') || ?,
        lessons = COALESCE(?, lessons),
        rating = COALESCE(?, rating),
        updated_at = CURRENT_TIMESTAMP
      WHERE trade_id = ?
    `);

    stmt.run(notes, lessons, rating, tradeId);
    logger.info('Notes added to trade', { tradeId });
  }

  /**
   * Get trade by ID
   */
  getTradeById(tradeId: string): TradeEntry | null {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE trade_id = ?');
    const row = stmt.get(tradeId) as any;
    return row ? this.mapRowToTrade(row) : null;
  }

  /**
   * Get open trades
   */
  getOpenTrades(): TradeEntry[] {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY entry_date DESC');
    const rows = stmt.all('OPEN') as any[];
    return rows.map(this.mapRowToTrade);
  }

  /**
   * Get recent trades
   */
  getRecentTrades(limit: number = 10): TradeEntry[] {
    const stmt = this.db.prepare('SELECT * FROM trades ORDER BY entry_date DESC LIMIT ?');
    const rows = stmt.all(limit) as any[];
    return rows.map(this.mapRowToTrade);
  }

  /**
   * Get trades by underlying
   */
  getTradesByUnderlying(underlying: Underlying, limit: number = 20): TradeEntry[] {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE underlying = ? ORDER BY entry_date DESC LIMIT ?');
    const rows = stmt.all(underlying, limit) as any[];
    return rows.map(this.mapRowToTrade);
  }

  // ============================================================================
  // PERFORMANCE ANALYTICS
  // ============================================================================

  /**
   * Get comprehensive performance statistics
   */
  getPerformanceStats(): PerformanceStats {
    const allTrades = this.db.prepare('SELECT * FROM trades ORDER BY entry_date DESC').all() as any[];
    const closedTrades = allTrades.filter(t => t.status === 'CLOSED');
    const openTrades = allTrades.filter(t => t.status === 'OPEN');

    const winningTrades = closedTrades.filter(t => t.realized_pnl > 0);
    const losingTrades = closedTrades.filter(t => t.realized_pnl < 0);

    const totalWins = winningTrades.reduce((sum, t) => sum + t.realized_pnl, 0);
    const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.realized_pnl, 0));

    const niftyTrades = closedTrades.filter(t => t.underlying === 'NIFTY');
    const bnfTrades = closedTrades.filter(t => t.underlying === 'BANKNIFTY');

    // Calculate current streak
    let currentStreak = 0;
    for (const trade of closedTrades) {
      if (trade.realized_pnl > 0) {
        if (currentStreak >= 0) currentStreak++;
        else break;
      } else if (trade.realized_pnl < 0) {
        if (currentStreak <= 0) currentStreak--;
        else break;
      }
    }

    return {
      totalTrades: allTrades.length,
      openTrades: openTrades.length,
      closedTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0,

      totalPnL: closedTrades.reduce((sum, t) => sum + (t.realized_pnl || 0), 0),
      avgWin: winningTrades.length > 0 ? totalWins / winningTrades.length : 0,
      avgLoss: losingTrades.length > 0 ? totalLosses / losingTrades.length : 0,
      largestWin: winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.realized_pnl)) : 0,
      largestLoss: losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.realized_pnl)) : 0,
      profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,

      avgDaysHeld: closedTrades.length > 0
        ? closedTrades.reduce((sum, t) => sum + (t.days_held || 0), 0) / closedTrades.length
        : 0,
      avgROI: closedTrades.length > 0
        ? closedTrades.reduce((sum, t) => sum + ((t.realized_pnl || 0) / t.margin_used) * 100, 0) / closedTrades.length
        : 0,

      niftyStats: {
        trades: niftyTrades.length,
        pnl: niftyTrades.reduce((sum, t) => sum + (t.realized_pnl || 0), 0),
        winRate: niftyTrades.length > 0
          ? (niftyTrades.filter(t => t.realized_pnl > 0).length / niftyTrades.length) * 100
          : 0,
      },
      bankniftyStats: {
        trades: bnfTrades.length,
        pnl: bnfTrades.reduce((sum, t) => sum + (t.realized_pnl || 0), 0),
        winRate: bnfTrades.length > 0
          ? (bnfTrades.filter(t => t.realized_pnl > 0).length / bnfTrades.length) * 100
          : 0,
      },

      last5Trades: allTrades.slice(0, 5).map(this.mapRowToTrade),
      currentStreak,
    };
  }

  /**
   * Get monthly P&L summary
   */
  getMonthlyPnL(): { month: string; pnl: number; trades: number }[] {
    const stmt = this.db.prepare(`
      SELECT
        strftime('%Y-%m', exit_date) as month,
        SUM(realized_pnl) as pnl,
        COUNT(*) as trades
      FROM trades
      WHERE status = 'CLOSED' AND exit_date IS NOT NULL
      GROUP BY strftime('%Y-%m', exit_date)
      ORDER BY month DESC
      LIMIT 12
    `);

    return stmt.all() as any[];
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private mapRowToTrade(row: any): TradeEntry {
    return {
      id: row.id,
      tradeId: row.trade_id,
      strategyType: row.strategy_type,
      underlying: row.underlying,
      entryDate: row.entry_date,
      entrySpot: row.entry_spot,
      ceStrike: row.ce_strike,
      peStrike: row.pe_strike,
      cePremium: row.ce_premium,
      pePremium: row.pe_premium,
      totalPremium: row.total_premium,
      lots: row.lots,
      marginUsed: row.margin_used,
      exitDate: row.exit_date,
      exitSpot: row.exit_spot,
      ceExitPrice: row.ce_exit_price,
      peExitPrice: row.pe_exit_price,
      exitReason: row.exit_reason,
      realizedPnL: row.realized_pnl,
      maxDrawdown: row.max_drawdown,
      maxProfit: row.max_profit,
      entryDelta: row.entry_delta,
      entryTheta: row.entry_theta,
      entryVega: row.entry_vega,
      entryIV: row.entry_iv,
      notes: row.notes,
      lessons: row.lessons,
      rating: row.rating,
      status: row.status,
      daysHeld: row.days_held,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let journalInstance: TradeJournal | null = null;

export function getTradeJournal(): TradeJournal {
  if (!journalInstance) {
    journalInstance = new TradeJournal();
  }
  return journalInstance;
}

export function resetTradeJournal(): void {
  if (journalInstance) {
    journalInstance.close();
    journalInstance = null;
  }
}
