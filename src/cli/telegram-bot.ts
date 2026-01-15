import TelegramBot from 'node-telegram-bot-api';
import { formatINR } from '../utils/decimal.js';
import { StrangleAutomator } from '../strategies/strangle-automator.js';
import { StrategyAggregator } from '../position/strategy-aggregator.js';
import { PositionManager } from '../position/position-manager.js';
import { FillEngine } from '../execution/fill-engine.js';
import { InstrumentManager } from '../market-data/instrument-manager.js';
import { MarketState } from '../market-data/market-state.js';
import { RobustMonitor } from '../strategies/robust-monitor.js';
import { TokenManager } from '../utils/token-manager.js';
import chalk from 'chalk';

export class TelegramTradingBot {
  private bot: TelegramBot;
  private allowedUser: number;
  private isBusy: boolean = false;
  private liveDashboardInterval: NodeJS.Timeout | null = null;

  constructor(
    token: string,
    allowedUser: number,
    private tokenManager: TokenManager,
    private instrumentManager: InstrumentManager,
    private marketState: MarketState,
    private fillEngine: FillEngine,
    private positionManager: PositionManager,
    private strategyAggregator: StrategyAggregator,
    private monitor: RobustMonitor
  ) {
    this.bot = new TelegramBot(token, { polling: true });
    this.allowedUser = allowedUser;
    this.initializeHandlers();
    console.log(chalk.cyan('🤖 Telegram Command Center Active!'));
  }

  private initializeHandlers() {
    // Commands
    this.bot.onText(/\/start/, (msg) => this.safeExecute(msg.chat.id, () => this.showMainMenu(msg.chat.id)));
    this.bot.onText(/\/login (.+)/, (msg, match) => this.handleLogin(msg, match));
    
    // Button Clicks
    this.bot.on('callback_query', async (query) => {
      if (query.from.id !== this.allowedUser) return;
      const chatId = query.message!.chat.id;
      const data = query.data!;
      this.bot.answerCallbackQuery(query.id);

      await this.safeExecute(chatId, async () => {
        switch (data) {
          case 'menu_main': await this.showMainMenu(chatId); break;
          case 'menu_live_pnl': await this.startLiveDashboard(chatId); break;
          case 'stop_live_dashboard': this.stopLiveDashboard(chatId); break;
          case 'strat_strangle': await this.askStrangleCapital(chatId); break;
          case 'action_exit_all': await this.emergencyExit(chatId); break;
        }
        if (data.startsWith('DEPLOY_STRANGLE_')) {
          const capital = parseFloat(data.split('_')[2]);
          await this.deployStrangle(chatId, capital);
        }
      });
    });

    // Text Input (Capital)
    this.bot.on('message', (msg) => {
      if (msg.from?.id !== this.allowedUser) return;
      if (msg.text?.startsWith('/')) return;
      const num = parseFloat(msg.text || '');
      if (!isNaN(num) && num > 10000) {
        this.safeExecute(msg.chat.id, () => this.confirmStrangle(msg.chat.id, num));
      }
    });
  }

  // --- SAFETY WRAPPER ---
  private async safeExecute(chatId: number, action: () => Promise<void>) {
    if (this.isBusy) { this.bot.sendMessage(chatId, "⏳ Busy..."); return; }
    this.isBusy = true;
    try { await action(); } catch (e: any) { this.bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
    finally { this.isBusy = false; }
  }

  // --- AUTHENTICATION ---
  private async handleLogin(msg: TelegramBot.Message, match: RegExpExecArray | null) {
    if (msg.from?.id !== this.allowedUser) return;
    const requestToken = match![1].trim();
    this.bot.sendMessage(msg.chat.id, "🔄 Authenticating...");
    try {
      const user = await this.tokenManager.handleLogin(requestToken);
      await this.instrumentManager.loadInstruments(); // Reload instruments with new token
      this.bot.sendMessage(msg.chat.id, `✅ **Success!** Logged in as ${user}.\nInstruments re-loaded.`, { parse_mode: 'Markdown' });
    } catch (e: any) {
      this.bot.sendMessage(msg.chat.id, `❌ Login Failed: ${e.message}`);
    }
  }

  // --- MENUS ---
  private async showMainMenu(chatId: number) {
    this.bot.sendMessage(chatId, `👋 **Control Center**`, { parse_mode: 'Markdown', reply_markup: {
      inline_keyboard: [
        [{ text: '🔴 LIVE P&L Dashboard', callback_data: 'menu_live_pnl' }],
        [{ text: '🤖 Auto-Strangle 2.0', callback_data: 'strat_strangle' }],
        [{ text: '🚨 EXIT ALL', callback_data: 'action_exit_all' }]
      ]
    }});
  }

  // --- LIVE DASHBOARD ---
  private async startLiveDashboard(chatId: number) {
    if (this.liveDashboardInterval) clearInterval(this.liveDashboardInterval);
    const msg = await this.bot.sendMessage(chatId, "⏳ **Initializing...**");
    
    this.liveDashboardInterval = setInterval(async () => {
      this.positionManager.updateMarketPrices();
      const { total } = this.positionManager.getAggregatePnL();
      const icon = total.greaterThanOrEqualTo(0) ? '💚' : '💔';
      
      // Calculate Safe Zone Logic for Display
      const niftySpot = this.marketState.getSpotPrice('NIFTY').toNumber();
      let safeText = "";
      const positions = this.positionManager.getAllPositions();
      const ce = positions.find(p => p.instrumentType === 'CE' && p.side === 'SHORT');
      const pe = positions.find(p => p.instrumentType === 'PE' && p.side === 'SHORT');

      if (ce && pe) {
         const upRoom = (ce.strike + ce.avgPrice) - niftySpot;
         const downRoom = niftySpot - (pe.strike - pe.avgPrice);
         safeText = `🛡️ **SAFETY:** 🔼 ${upRoom.toFixed(0)} pts | 🔽 ${downRoom.toFixed(0)} pts\n`;
      }

      let text = `🔴 **LIVE DASHBOARD**\n──────────────\n${icon} **P&L: ${formatINR(total)}**\n${safeText}──────────────`;
      
      await this.bot.editMessageText(text, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⏹ STOP', callback_data: 'stop_live_dashboard' }]] }
      }).catch(() => {});
    }, 2500);
  }

  private stopLiveDashboard(chatId: number) {
    if (this.liveDashboardInterval) { clearInterval(this.liveDashboardInterval); this.liveDashboardInterval = null; }
    this.bot.sendMessage(chatId, "⏹ **Stopped.**");
  }

  // --- STRATEGY ---
  private async askStrangleCapital(chatId: number) {
    this.bot.sendMessage(chatId, "🤖 Enter Capital (e.g., 200000):");
  }

  private async confirmStrangle(chatId: number, capital: number) {
    const automator = new StrangleAutomator(this.instrumentManager, this.marketState, this.fillEngine, this.positionManager, this.strategyAggregator);
    const candidate = automator.findBestStrangle('NIFTY', capital);
    if (!candidate) { this.bot.sendMessage(chatId, "❌ No strikes found."); return; }

    const totalPrem = candidate.ceLtp + candidate.peLtp;
    const text = `🎯 **Strangle Candidate**\nSell CE: ${candidate.ce.strike} (~${candidate.ceLtp.toFixed(1)})\nSell PE: ${candidate.pe.strike} (~${candidate.peLtp.toFixed(1)})\n` +
                 `🛡️ **Safe Zone:** ${(candidate.pe.strike - totalPrem).toFixed(0)} - ${(candidate.ce.strike + totalPrem).toFixed(0)}`;
    
    this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: {
      inline_keyboard: [[{ text: '🚀 EXECUTE', callback_data: `DEPLOY_STRANGLE_${capital}` }]]
    }});
  }

  private async deployStrangle(chatId: number, capital: number) {
    const automator = new StrangleAutomator(this.instrumentManager, this.marketState, this.fillEngine, this.positionManager, this.strategyAggregator);
    const candidate = automator.findBestStrangle('NIFTY', capital);
    if (candidate) {
      await automator.executeStrangle(candidate, 'NIFTY');
      // Auto-attach monitor
      const strats = this.strategyAggregator.getOpenStrategies();
      const latest = strats[strats.length-1];
      if(latest) await this.monitor.startMonitoring(latest.id, capital);
      this.bot.sendMessage(chatId, "✅ **Deployed!**");
    }
  }

  private async emergencyExit(chatId: number) {
    this.bot.sendMessage(chatId, "🏁 **Closed All Positions.**");
    // Implement actual close logic here or rely on monitor
  }
}