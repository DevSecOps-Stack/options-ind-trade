import TelegramBot from 'node-telegram-bot-api';
import { formatINR } from '../utils/decimal.js';
import { calculateStrangleMargin, getLotSize } from '../utils/margin-calculator.js';
import { getTradeJournal, type TradeEntry } from '../journal/trade-journal.js';
import { StrangleAutomator } from '../strategies/strangle-automator.js';
import { StrategyAggregator } from '../position/strategy-aggregator.js';
import { PositionManager } from '../position/position-manager.js';
import { FillEngine } from '../execution/fill-engine.js';
import { InstrumentManager } from '../market-data/instrument-manager.js';
import { MarketStateManager } from '../market-data/market-state.js';
import { RobustMonitor } from '../strategies/robust-monitor.js';
import { TokenManager } from '../utils/token-manager.js';
import { logger } from '../utils/logger.js';
import chalk from 'chalk';

export class TelegramTradingBot {
  private bot: TelegramBot;
  private allowedUser: number;
  private isBusy: boolean = false;
  private liveDashboardInterval: NodeJS.Timeout | null = null;
  private startTime: Date = new Date();

  constructor(
    token: string,
    allowedUser: number,
    private tokenManager: TokenManager,
    private instrumentManager: InstrumentManager,
    private marketState: MarketStateManager,
    private fillEngine: FillEngine,
    private positionManager: PositionManager,
    private strategyAggregator: StrategyAggregator,
    private monitor: RobustMonitor
  ) {
    this.bot = new TelegramBot(token, { polling: true });
    this.allowedUser = allowedUser;
    this.initializeHandlers();
    console.log(chalk.cyan('🤖 Telegram Command Center Active!'));
    logger.info('Telegram bot initialized', { allowedUser });
  }

  private initializeHandlers() {
    // Text Commands
    this.bot.onText(/\/start/, (msg) => this.safeExecute(msg.chat.id, () => this.showMainMenu(msg.chat.id)));
    this.bot.onText(/\/menu/, (msg) => this.safeExecute(msg.chat.id, () => this.showMainMenu(msg.chat.id)));
    this.bot.onText(/\/help/, (msg) => this.safeExecute(msg.chat.id, () => this.showHelp(msg.chat.id)));
    this.bot.onText(/\/login (.+)/, (msg, match) => this.handleLogin(msg, match));
    this.bot.onText(/\/status/, (msg) => this.safeExecute(msg.chat.id, () => this.showStatus(msg.chat.id)));
    this.bot.onText(/\/positions/, (msg) => this.safeExecute(msg.chat.id, () => this.showPositions(msg.chat.id)));
    this.bot.onText(/\/pnl/, (msg) => this.safeExecute(msg.chat.id, () => this.showPnL(msg.chat.id)));
    this.bot.onText(/\/greeks/, (msg) => this.safeExecute(msg.chat.id, () => this.showGreeks(msg.chat.id)));
    this.bot.onText(/\/strategies/, (msg) => this.safeExecute(msg.chat.id, () => this.showStrategies(msg.chat.id)));
    this.bot.onText(/\/spot/, (msg) => this.safeExecute(msg.chat.id, () => this.showSpotPrices(msg.chat.id)));
    this.bot.onText(/\/chain(?:\s+(\w+))?/, (msg, match) => this.safeExecute(msg.chat.id, () => this.showOptionChain(msg.chat.id, match?.[1])));
    this.bot.onText(/\/margin(?:\s+(\w+))?/, (msg, match) => this.safeExecute(msg.chat.id, () => this.showMarginEstimate(msg.chat.id, match?.[1])));
    this.bot.onText(/\/journal/, (msg) => this.safeExecute(msg.chat.id, () => this.showJournal(msg.chat.id)));
    this.bot.onText(/\/stats/, (msg) => this.safeExecute(msg.chat.id, () => this.showStats(msg.chat.id)));

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
          case 'strat_strangle_nifty': await this.askStrangleCapital(chatId, 'NIFTY'); break;
          case 'strat_strangle_banknifty': await this.askStrangleCapital(chatId, 'BANKNIFTY'); break;
          case 'action_exit_all': await this.confirmExitAll(chatId); break;
          case 'action_exit_confirmed': await this.emergencyExit(chatId); break;
          case 'show_positions': await this.showPositions(chatId); break;
          case 'show_pnl': await this.showPnL(chatId); break;
          case 'show_greeks': await this.showGreeks(chatId); break;
          case 'show_status': await this.showStatus(chatId); break;
          case 'chain_nifty': await this.showOptionChain(chatId, 'NIFTY'); break;
          case 'chain_banknifty': await this.showOptionChain(chatId, 'BANKNIFTY'); break;
          case 'margin_nifty': await this.showMarginEstimate(chatId, 'NIFTY'); break;
          case 'margin_banknifty': await this.showMarginEstimate(chatId, 'BANKNIFTY'); break;
          case 'show_journal': await this.showJournal(chatId); break;
          case 'show_stats': await this.showStats(chatId); break;
        }
        if (data.startsWith('chain_exp_')) {
          const parts = data.split('_');
          const underlying = parts[2] as 'NIFTY' | 'BANKNIFTY';
          const expiryIndex = parseInt(parts[3] ?? '0');
          await this.showOptionChain(chatId, underlying, expiryIndex);
        }
        if (data.startsWith('DEPLOY_STRANGLE_')) {
          const parts = data.split('_');
          const underlying = parts[2] as 'NIFTY' | 'BANKNIFTY';
          const capital = parseFloat(parts[3] ?? '200000');
          await this.deployStrangle(chatId, underlying, capital);
        }
      });
    });

    // Text Input (Capital)
    this.bot.on('message', (msg) => {
      if (msg.from?.id !== this.allowedUser) return;
      if (msg.text?.startsWith('/')) return;
      const num = parseFloat(msg.text || '');
      if (!isNaN(num) && num > 10000) {
        this.safeExecute(msg.chat.id, () => this.confirmStrangle(msg.chat.id, 'NIFTY', num));
      }
    });
  }

  // --- SAFETY WRAPPER ---
  private async safeExecute(chatId: number, action: () => Promise<void>) {
    if (this.isBusy) {
      this.bot.sendMessage(chatId, "⏳ Processing previous request...");
      return;
    }
    this.isBusy = true;
    try {
      await action();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      this.bot.sendMessage(chatId, `❌ Error: ${errorMessage}`);
      logger.error('Telegram bot error', { error: e });
    } finally {
      this.isBusy = false;
    }
  }

  // --- HELP COMMAND ---
  private async showHelp(chatId: number) {
    const helpText = `
📚 **NSE Options Paper Trading Bot**

**Available Commands:**
/start - Main menu
/menu - Main menu (alias)
/help - Show this help
/login <token> - Login with Zerodha request token
/status - System status
/positions - View all open positions
/pnl - View P&L summary
/greeks - View net Greeks
/strategies - View active strategies
/spot - View spot prices
/chain - View NIFTY options chain
/chain banknifty - View BANKNIFTY options chain
/margin - NIFTY strangle margin estimate
/margin banknifty - BANKNIFTY margin estimate
/journal - View trade journal
/stats - Performance statistics

**Quick Actions:**
Use the interactive menu from /start for trading operations.

**Tips:**
• Login daily with fresh request token
• Monitor positions via Live Dashboard
• Use Auto-Strangle for automated entries
`;
    await this.bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
  }

  // --- AUTHENTICATION ---
  private async handleLogin(msg: TelegramBot.Message, match: RegExpExecArray | null) {
    if (msg.from?.id !== this.allowedUser) return;
    const requestToken = match![1].trim();
    await this.bot.sendMessage(msg.chat.id, "🔄 Authenticating...");
    try {
      const user = await this.tokenManager.handleLogin(requestToken);
      await this.instrumentManager.loadInstruments();
      await this.bot.sendMessage(msg.chat.id,
        `✅ **Success!** Logged in as ${user}.\n📊 Instruments loaded: ${this.instrumentManager.getAllInstruments().length}`,
        { parse_mode: 'Markdown' }
      );
      logger.info('Telegram login successful', { user });
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      await this.bot.sendMessage(msg.chat.id, `❌ Login Failed: ${errorMessage}`);
    }
  }

  // --- MENUS ---
  private async showMainMenu(chatId: number) {
    const pnl = this.positionManager.getAggregatePnL();
    const pnlIcon = pnl.total.greaterThanOrEqualTo(0) ? '💚' : '💔';

    await this.bot.sendMessage(chatId,
      `👋 **NSE Options Control Center**\n\n${pnlIcon} Current P&L: **${formatINR(pnl.total)}**\n📊 Positions: ${pnl.positionCount}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔴 LIVE Dashboard', callback_data: 'menu_live_pnl' }],
            [
              { text: '🤖 NIFTY Strangle', callback_data: 'strat_strangle_nifty' },
              { text: '🤖 BANKNIFTY', callback_data: 'strat_strangle_banknifty' }
            ],
            [
              { text: '📊 Positions', callback_data: 'show_positions' },
              { text: '📈 P&L', callback_data: 'show_pnl' }
            ],
            [
              { text: '📉 Greeks', callback_data: 'show_greeks' },
              { text: '⚙️ Status', callback_data: 'show_status' }
            ],
            [
              { text: '🔗 NIFTY Chain', callback_data: 'chain_nifty' },
              { text: '🔗 BNF Chain', callback_data: 'chain_banknifty' }
            ],
            [
              { text: '💰 NIFTY Margin', callback_data: 'margin_nifty' },
              { text: '💰 BNF Margin', callback_data: 'margin_banknifty' }
            ],
            [
              { text: '📓 Journal', callback_data: 'show_journal' },
              { text: '📊 Stats', callback_data: 'show_stats' }
            ],
            [{ text: '🚨 EXIT ALL POSITIONS', callback_data: 'action_exit_all' }]
          ]
        }
      });
  }

  // --- STATUS ---
  private async showStatus(chatId: number) {
    const uptime = this.getUptime();
    const instruments = this.instrumentManager.getAllInstruments().length;
    const positions = this.positionManager.getAllPositions().length;
    const strategies = this.strategyAggregator.getOpenStrategies().length;

    const niftySpot = this.marketState.getSpotPrice('NIFTY').toNumber();
    const bnfSpot = this.marketState.getSpotPrice('BANKNIFTY').toNumber();

    const statusText = `
⚙️ **System Status**
────────────────
⏱ Uptime: ${uptime}
📊 Instruments: ${instruments}
📈 Open Positions: ${positions}
🎯 Active Strategies: ${strategies}

**Market Data:**
NIFTY: ${niftySpot > 0 ? niftySpot.toFixed(2) : '⏳ Loading...'}
BANKNIFTY: ${bnfSpot > 0 ? bnfSpot.toFixed(2) : '⏳ Loading...'}

**Status:** ${instruments > 0 ? '✅ Online' : '⚠️ Waiting for data'}
`;
    await this.bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
  }

  // --- POSITIONS ---
  private async showPositions(chatId: number) {
    const positions = this.positionManager.getAllPositions();

    if (positions.length === 0) {
      await this.bot.sendMessage(chatId, "📊 **No open positions**", { parse_mode: 'Markdown' });
      return;
    }

    let text = "📊 **Open Positions**\n────────────────\n";

    for (const pos of positions) {
      const icon = pos.unrealizedPnL.greaterThanOrEqualTo(0) ? '🟢' : '🔴';
      const side = pos.side === 'LONG' ? '📈' : '📉';
      text += `${side} **${pos.symbol}**\n`;
      text += `   Qty: ${pos.quantity} | Avg: ₹${pos.avgPrice.toFixed(2)}\n`;
      text += `   ${icon} P&L: ${formatINR(pos.unrealizedPnL)}\n\n`;
    }

    await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  // --- P&L ---
  private async showPnL(chatId: number) {
    const pnl = this.positionManager.getAggregatePnL();
    const icon = pnl.total.greaterThanOrEqualTo(0) ? '💚' : '💔';

    const text = `
📈 **P&L Summary**
────────────────
${icon} **Total: ${formatINR(pnl.total)}**

Realized: ${formatINR(pnl.realized)}
Unrealized: ${formatINR(pnl.unrealized)}

📊 Positions: ${pnl.positionCount}
📝 Trades: ${pnl.tradeCount}
`;
    await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  // --- GREEKS ---
  private async showGreeks(chatId: number) {
    this.positionManager.updateMarketPrices();
    const greeks = this.positionManager.getNetGreeks();

    const text = `
📉 **Net Greeks**
────────────────
Δ Delta: ${greeks.delta.toFixed(4)}
Γ Gamma: ${greeks.gamma.toFixed(6)}
Θ Theta: ${greeks.theta.toFixed(2)}/day
ν Vega: ${greeks.vega.toFixed(4)}

*Updated at ${new Date().toLocaleTimeString()}*
`;
    await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  // --- STRATEGIES ---
  private async showStrategies(chatId: number) {
    const strategies = this.strategyAggregator.getOpenStrategies();

    if (strategies.length === 0) {
      await this.bot.sendMessage(chatId, "🎯 **No active strategies**", { parse_mode: 'Markdown' });
      return;
    }

    let text = "🎯 **Active Strategies**\n────────────────\n";

    for (const strat of strategies) {
      text += `**${strat.name}**\n`;
      text += `   Type: ${strat.type} | ${strat.underlying}\n`;
      text += `   Legs: ${strat.positions.length}\n\n`;
    }

    await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  // --- SPOT PRICES ---
  private async showSpotPrices(chatId: number) {
    const nifty = this.marketState.getSpotPrice('NIFTY').toNumber();
    const bnf = this.marketState.getSpotPrice('BANKNIFTY').toNumber();

    const text = `
📍 **Spot Prices**
────────────────
NIFTY: ${nifty > 0 ? `₹${nifty.toFixed(2)}` : '⏳ Loading...'}
BANKNIFTY: ${bnf > 0 ? `₹${bnf.toFixed(2)}` : '⏳ Loading...'}

*${new Date().toLocaleTimeString()}*
`;
    await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  // --- OPTIONS CHAIN ---
  private async showOptionChain(chatId: number, undInput?: string, expiryIndex: number = 0) {
    const underlying = (undInput?.toUpperCase() === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY') as 'NIFTY' | 'BANKNIFTY';

    // Get available expiries
    const expiries = this.instrumentManager.getAvailableExpiries(underlying);

    if (expiries.length === 0) {
      await this.bot.sendMessage(chatId,
        `⚠️ No expiries found for ${underlying}.\nPlease login first with /login <token>`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Select expiry
    const selectedExpiry = expiries[Math.min(expiryIndex, expiries.length - 1)]!;
    const expiryStr = selectedExpiry.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    // Get spot price for ATM calculation
    const spotPrice = this.marketState.getSpotPrice(underlying).toNumber();

    if (spotPrice <= 0) {
      await this.bot.sendMessage(chatId,
        `⚠️ Spot price not available for ${underlying}.\nMarket data may still be loading.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Get option chain from instrument manager
    const chainData = this.instrumentManager.getOptionChain(underlying, selectedExpiry);

    if (!chainData || chainData.strikes.size === 0) {
      await this.bot.sendMessage(chatId,
        `⚠️ No option chain data for ${underlying} ${expiryStr}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Determine ATM strike
    const strikeDiff = underlying === 'BANKNIFTY' ? 100 : 50;
    const atmStrike = Math.round(spotPrice / strikeDiff) * strikeDiff;

    // Get strikes around ATM (5 above, 5 below = 11 strikes)
    const allStrikes = Array.from(chainData.strikes.keys()).sort((a, b) => a - b);
    const atmIndex = allStrikes.findIndex(s => s >= atmStrike);
    const startIdx = Math.max(0, atmIndex - 5);
    const endIdx = Math.min(allStrikes.length, atmIndex + 6);
    const displayStrikes = allStrikes.slice(startIdx, endIdx);

    // Build chain display
    let text = `📊 **${underlying} Options Chain**\n`;
    text += `📅 Expiry: ${expiryStr}\n`;
    text += `📍 Spot: ₹${spotPrice.toFixed(2)} | ATM: ${atmStrike}\n`;
    text += `────────────────────────\n`;
    text += `\`CE LTP  │ STRIKE │  PE LTP\`\n`;
    text += `────────────────────────\n`;

    for (const strike of displayStrikes) {
      const entry = chainData.strikes.get(strike);
      if (!entry) continue;

      // Get LTP from market state
      const ceLtp = entry.ce ? this.marketState.getLTP(entry.ce.instrumentToken).toNumber() : 0;
      const peLtp = entry.pe ? this.marketState.getLTP(entry.pe.instrumentToken).toNumber() : 0;

      // Format prices
      const cePrice = ceLtp > 0 ? ceLtp.toFixed(2).padStart(7) : '   ---';
      const pePrice = peLtp > 0 ? peLtp.toFixed(2).padStart(7) : '---   ';
      const strikeStr = strike.toString().padStart(6).padEnd(6);

      // Highlight ATM
      const isATM = strike === atmStrike;
      const marker = isATM ? '▶' : ' ';

      text += `\`${cePrice} │${marker}${strikeStr}│ ${pePrice}\`\n`;
    }

    text += `────────────────────────\n`;
    text += `_Updated: ${new Date().toLocaleTimeString()}_`;

    // Build expiry selection buttons (show first 4 expiries)
    const expiryButtons = expiries.slice(0, 4).map((exp, idx) => ({
      text: idx === expiryIndex ? `✓ ${exp.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` :
                                  exp.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
      callback_data: `chain_exp_${underlying}_${idx}`
    }));

    await this.bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: underlying === 'NIFTY' ? '✓ NIFTY' : 'NIFTY', callback_data: 'chain_nifty' },
            { text: underlying === 'BANKNIFTY' ? '✓ BANKNIFTY' : 'BANKNIFTY', callback_data: 'chain_banknifty' }
          ],
          expiryButtons,
          [{ text: '🔄 Refresh', callback_data: `chain_exp_${underlying}_${expiryIndex}` }],
          [{ text: '🏠 Main Menu', callback_data: 'menu_main' }]
        ]
      }
    });
  }

  // --- MARGIN ESTIMATE ---
  private async showMarginEstimate(chatId: number, undInput?: string) {
    const underlying = (undInput?.toUpperCase() === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY') as 'NIFTY' | 'BANKNIFTY';

    // Get spot price
    const spotPrice = this.marketState.getSpotPrice(underlying).toNumber();

    if (spotPrice <= 0) {
      await this.bot.sendMessage(chatId,
        `⚠️ Spot price not available for ${underlying}.\nPlease login first with /login <token>`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Get nearest expiry
    const expiries = this.instrumentManager.getAvailableExpiries(underlying);
    if (expiries.length === 0) {
      await this.bot.sendMessage(chatId, `⚠️ No expiries found for ${underlying}.`);
      return;
    }

    const nearestExpiry = expiries[0]!;
    const chainData = this.instrumentManager.getOptionChain(underlying, nearestExpiry);

    if (!chainData || chainData.strikes.size === 0) {
      await this.bot.sendMessage(chatId, `⚠️ No option chain data for ${underlying}.`);
      return;
    }

    // Find ATM strike and typical OTM strikes for strangle
    const strikeDiff = underlying === 'BANKNIFTY' ? 100 : 50;
    const atmStrike = Math.round(spotPrice / strikeDiff) * strikeDiff;

    // Typical short strangle: ~200-300 points OTM for NIFTY, ~400-500 for BANKNIFTY
    const otmDistance = underlying === 'BANKNIFTY' ? 500 : 250;
    const ceStrike = atmStrike + otmDistance;
    const peStrike = atmStrike - otmDistance;

    // Get option data
    const ceEntry = chainData.strikes.get(ceStrike);
    const peEntry = chainData.strikes.get(peStrike);

    if (!ceEntry?.ce || !peEntry?.pe) {
      await this.bot.sendMessage(chatId,
        `⚠️ Could not find strikes ${ceStrike} CE / ${peStrike} PE.\nTry after market data loads.`
      );
      return;
    }

    // Get LTPs
    const ceLtp = this.marketState.getLTP(ceEntry.ce.instrumentToken).toNumber();
    const peLtp = this.marketState.getLTP(peEntry.pe.instrumentToken).toNumber();

    if (ceLtp <= 0 || peLtp <= 0) {
      await this.bot.sendMessage(chatId,
        `⚠️ Option prices not available yet. Wait for market data to load.`
      );
      return;
    }

    // Calculate margin
    const margin = calculateStrangleMargin(
      underlying,
      spotPrice,
      ceStrike,
      peStrike,
      ceLtp,
      peLtp,
      1 // 1 lot
    );

    const lotSize = getLotSize(underlying);
    const totalPremium = ceLtp + peLtp;
    const upperBreakeven = ceStrike + totalPremium;
    const lowerBreakeven = peStrike - totalPremium;
    const expiryStr = nearestExpiry.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

    const text = `
💰 **${underlying} Short Strangle - Margin Estimate**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📍 Spot: ₹${spotPrice.toFixed(2)}
📅 Expiry: ${expiryStr}

**Position (1 Lot = ${lotSize} qty):**
📉 SELL ${ceStrike} CE @ ₹${ceLtp.toFixed(2)}
📈 SELL ${peStrike} PE @ ₹${peLtp.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**💵 Premium Received:**
CE: ₹${(ceLtp * lotSize).toLocaleString('en-IN')}
PE: ₹${(peLtp * lotSize).toLocaleString('en-IN')}
**Total: ₹${margin.premiumReceived.toLocaleString('en-IN')}**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**🏦 Margin Required:**
CE Leg: ~₹${margin.ceMargin.toLocaleString('en-IN')}
PE Leg: ~₹${margin.peMargin.toLocaleString('en-IN')}
Benefit: -₹${margin.marginBenefit.toLocaleString('en-IN')} ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**Total Margin: ₹${margin.totalMargin.toLocaleString('en-IN')}**
Net Blocked: ₹${margin.netMarginBlocked.toLocaleString('en-IN')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**📊 Return Analysis:**
ROI: **${margin.roi}%** (if expires OTM)
Max Profit: ₹${margin.premiumReceived.toLocaleString('en-IN')}
Max Loss: ${margin.maxLoss}

**🛡️ Breakeven Points:**
Upper: ${upperBreakeven.toFixed(0)} (${((upperBreakeven - spotPrice) / spotPrice * 100).toFixed(1)}% up)
Lower: ${lowerBreakeven.toFixed(0)} (${((spotPrice - lowerBreakeven) / spotPrice * 100).toFixed(1)}% down)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Approximate values for learning._
_Check broker for actual margin._
`;

    await this.bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: underlying === 'NIFTY' ? '✓ NIFTY' : 'NIFTY', callback_data: 'margin_nifty' },
            { text: underlying === 'BANKNIFTY' ? '✓ BANKNIFTY' : 'BANKNIFTY', callback_data: 'margin_banknifty' }
          ],
          [{ text: '🔄 Refresh', callback_data: `margin_${underlying.toLowerCase()}` }],
          [{ text: '🏠 Main Menu', callback_data: 'menu_main' }]
        ]
      }
    });
  }

  // --- TRADE JOURNAL ---
  private async showJournal(chatId: number) {
    const journal = getTradeJournal();
    const openTrades = journal.getOpenTrades();
    const recentTrades = journal.getRecentTrades(5);

    let text = `📓 **Trade Journal**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Open trades
    if (openTrades.length > 0) {
      text += `**🔴 Open Positions (${openTrades.length})**\n`;
      for (const trade of openTrades) {
        const days = Math.ceil((Date.now() - new Date(trade.entryDate).getTime()) / (1000 * 60 * 60 * 24));
        text += `• ${trade.underlying} ${trade.strategyType}\n`;
        text += `  Entry: ₹${trade.totalPremium.toFixed(0)} | ${days}d ago\n`;
        if (trade.ceStrike && trade.peStrike) {
          text += `  Strikes: ${trade.peStrike}PE - ${trade.ceStrike}CE\n`;
        }
        text += `\n`;
      }
    } else {
      text += `**🔴 No open positions**\n\n`;
    }

    // Recent closed trades
    const closedTrades = recentTrades.filter(t => t.status === 'CLOSED');
    if (closedTrades.length > 0) {
      text += `**📋 Recent Closed Trades**\n`;
      for (const trade of closedTrades.slice(0, 5)) {
        const pnlIcon = (trade.realizedPnL ?? 0) >= 0 ? '✅' : '❌';
        const pnl = trade.realizedPnL ?? 0;
        text += `${pnlIcon} ${trade.underlying} | ₹${pnl.toLocaleString('en-IN')} | ${trade.daysHeld}d\n`;
      }
    } else {
      text += `**📋 No closed trades yet**\n`;
    }

    text += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `_Use /stats for detailed analytics_`;

    await this.bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 View Stats', callback_data: 'show_stats' }],
          [{ text: '🔄 Refresh', callback_data: 'show_journal' }],
          [{ text: '🏠 Main Menu', callback_data: 'menu_main' }]
        ]
      }
    });
  }

  // --- PERFORMANCE STATS ---
  private async showStats(chatId: number) {
    const journal = getTradeJournal();
    const stats = journal.getPerformanceStats();

    const streakIcon = stats.currentStreak > 0 ? '🔥' : stats.currentStreak < 0 ? '❄️' : '➖';
    const streakText = stats.currentStreak > 0
      ? `${stats.currentStreak} wins`
      : stats.currentStreak < 0
        ? `${Math.abs(stats.currentStreak)} losses`
        : 'neutral';

    let text = `📊 **Performance Statistics**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (stats.totalTrades === 0) {
      text += `No trades recorded yet.\n\n`;
      text += `Start paper trading to build your track record!\n`;
      text += `Use the Strangle buttons from /menu to begin.`;
    } else {
      text += `**📈 Overview**\n`;
      text += `Total Trades: ${stats.totalTrades} (${stats.openTrades} open)\n`;
      text += `Win Rate: **${stats.winRate.toFixed(1)}%** (${stats.winningTrades}W / ${stats.losingTrades}L)\n`;
      text += `Current Streak: ${streakIcon} ${streakText}\n\n`;

      text += `**💰 P&L Summary**\n`;
      const pnlIcon = stats.totalPnL >= 0 ? '💚' : '💔';
      text += `${pnlIcon} Total P&L: **₹${stats.totalPnL.toLocaleString('en-IN')}**\n`;
      text += `Avg Win: ₹${stats.avgWin.toFixed(0)} | Avg Loss: ₹${stats.avgLoss.toFixed(0)}\n`;
      text += `Largest Win: ₹${stats.largestWin.toFixed(0)}\n`;
      text += `Largest Loss: ₹${stats.largestLoss.toFixed(0)}\n`;
      text += `Profit Factor: ${stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}\n\n`;

      text += `**⏱ Time Analysis**\n`;
      text += `Avg Days Held: ${stats.avgDaysHeld.toFixed(1)}\n`;
      text += `Avg ROI: ${stats.avgROI.toFixed(2)}%\n\n`;

      text += `**📍 By Underlying**\n`;
      text += `NIFTY: ${stats.niftyStats.trades} trades | ₹${stats.niftyStats.pnl.toLocaleString('en-IN')} | ${stats.niftyStats.winRate.toFixed(0)}% WR\n`;
      text += `BANKNIFTY: ${stats.bankniftyStats.trades} trades | ₹${stats.bankniftyStats.pnl.toLocaleString('en-IN')} | ${stats.bankniftyStats.winRate.toFixed(0)}% WR\n`;
    }

    text += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `_Updated: ${new Date().toLocaleTimeString()}_`;

    await this.bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📓 View Journal', callback_data: 'show_journal' }],
          [{ text: '🔄 Refresh', callback_data: 'show_stats' }],
          [{ text: '🏠 Main Menu', callback_data: 'menu_main' }]
        ]
      }
    });
  }

  // --- LIVE DASHBOARD ---
  private async startLiveDashboard(chatId: number) {
    if (this.liveDashboardInterval) clearInterval(this.liveDashboardInterval);
    const msg = await this.bot.sendMessage(chatId, "⏳ **Initializing Live Dashboard...**", { parse_mode: 'Markdown' });

    this.liveDashboardInterval = setInterval(async () => {
      this.positionManager.updateMarketPrices();
      const { total, realized, unrealized } = this.positionManager.getAggregatePnL();
      const icon = total.greaterThanOrEqualTo(0) ? '💚' : '💔';

      const niftySpot = this.marketState.getSpotPrice('NIFTY').toNumber();
      const bnfSpot = this.marketState.getSpotPrice('BANKNIFTY').toNumber();

      // Calculate Safe Zone for short strangles
      let safeText = "";
      const positions = this.positionManager.getAllPositions();
      const shortCE = positions.find(p => p.instrumentType === 'CE' && p.side === 'SHORT');
      const shortPE = positions.find(p => p.instrumentType === 'PE' && p.side === 'SHORT');

      if (shortCE && shortPE && shortCE.strike && shortPE.strike) {
        const spotPrice = this.marketState.getSpotPrice(shortCE.underlying).toNumber();
        const totalPremium = shortCE.avgPrice.plus(shortPE.avgPrice).toNumber();
        const upperBreak = shortCE.strike + totalPremium;
        const lowerBreak = shortPE.strike - totalPremium;
        const upRoom = upperBreak - spotPrice;
        const downRoom = spotPrice - lowerBreak;

        safeText = `\n🛡️ **Safe Zone**\n🔼 ${upRoom.toFixed(0)} pts to ${upperBreak.toFixed(0)}\n🔽 ${downRoom.toFixed(0)} pts to ${lowerBreak.toFixed(0)}\n`;
      }

      const text = `🔴 **LIVE DASHBOARD**
────────────────
${icon} **P&L: ${formatINR(total)}**
   Realized: ${formatINR(realized)}
   Unrealized: ${formatINR(unrealized)}

📍 NIFTY: ${niftySpot > 0 ? niftySpot.toFixed(2) : '---'}
📍 BANKNIFTY: ${bnfSpot > 0 ? bnfSpot.toFixed(2) : '---'}
${safeText}
────────────────
⏱ ${new Date().toLocaleTimeString()}`;

      await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏹ STOP DASHBOARD', callback_data: 'stop_live_dashboard' }],
            [{ text: '🏠 Main Menu', callback_data: 'menu_main' }]
          ]
        }
      }).catch(() => { /* Message unchanged */ });
    }, 3000);
  }

  private stopLiveDashboard(chatId: number) {
    if (this.liveDashboardInterval) {
      clearInterval(this.liveDashboardInterval);
      this.liveDashboardInterval = null;
    }
    this.bot.sendMessage(chatId, "⏹ **Dashboard Stopped**", { parse_mode: 'Markdown' });
  }

  // --- STRANGLE STRATEGY ---
  private async askStrangleCapital(chatId: number, underlying?: 'NIFTY' | 'BANKNIFTY') {
    const und = underlying || 'NIFTY';
    await this.bot.sendMessage(chatId,
      `🤖 **Auto-Strangle (${und})**\n\nEnter capital amount (min ₹50,000):`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '₹1L', callback_data: `DEPLOY_STRANGLE_${und}_100000` },
              { text: '₹2L', callback_data: `DEPLOY_STRANGLE_${und}_200000` },
              { text: '₹5L', callback_data: `DEPLOY_STRANGLE_${und}_500000` }
            ],
            [{ text: '🏠 Back to Menu', callback_data: 'menu_main' }]
          ]
        }
      });
  }

  private async confirmStrangle(chatId: number, underlying: 'NIFTY' | 'BANKNIFTY', capital: number) {
    const automator = new StrangleAutomator(
      this.instrumentManager, this.marketState, this.fillEngine,
      this.positionManager, this.strategyAggregator
    );
    const candidate = automator.findBestStrangle(underlying, capital);

    if (!candidate) {
      await this.bot.sendMessage(chatId, "❌ No suitable strikes found. Market data may still be loading.");
      return;
    }

    const totalPrem = candidate.ceLtp + candidate.peLtp;
    const lotSize = candidate.ce.lotSize;
    const maxProfit = totalPrem * lotSize;
    const peStrike = candidate.pe.strike ?? 0;
    const ceStrike = candidate.ce.strike ?? 0;
    const safeZone = `${(peStrike - totalPrem).toFixed(0)} - ${(ceStrike + totalPrem).toFixed(0)}`;

    // Calculate margin estimate
    const spotPrice = this.marketState.getSpotPrice(underlying).toNumber();
    const margin = calculateStrangleMargin(
      underlying,
      spotPrice,
      ceStrike,
      peStrike,
      candidate.ceLtp,
      candidate.peLtp,
      1
    );

    const text = `
🎯 **Strangle Candidate (${underlying})**
────────────────
📉 SELL CE: ${ceStrike} @ ₹${candidate.ceLtp.toFixed(2)}
📈 SELL PE: ${peStrike} @ ₹${candidate.peLtp.toFixed(2)}

💰 **Premium: ₹${margin.premiumReceived.toLocaleString('en-IN')}**
🏦 **Margin: ~₹${margin.totalMargin.toLocaleString('en-IN')}**
📊 **ROI: ${margin.roi}%** (if expires OTM)

🛡️ Safe Zone: ${safeZone}
⚠️ Max Loss: Unlimited

*Capital: ₹${capital.toLocaleString('en-IN')}*
`;

    await this.bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 EXECUTE STRANGLE', callback_data: `DEPLOY_STRANGLE_${underlying}_${capital}` }],
          [{ text: '❌ Cancel', callback_data: 'menu_main' }]
        ]
      }
    });
  }

  private async deployStrangle(chatId: number, underlying: 'NIFTY' | 'BANKNIFTY', capital: number) {
    await this.bot.sendMessage(chatId, `⏳ Executing ${underlying} Strangle...`);

    const automator = new StrangleAutomator(
      this.instrumentManager, this.marketState, this.fillEngine,
      this.positionManager, this.strategyAggregator
    );
    const candidate = automator.findBestStrangle(underlying, capital);

    if (!candidate) {
      await this.bot.sendMessage(chatId, "❌ Failed: Could not find suitable strikes.");
      return;
    }

    await automator.executeStrangle(candidate, underlying);

    // Auto-attach monitor to new strategy
    const strategies = this.strategyAggregator.getOpenStrategies();
    const latest = strategies[strategies.length - 1];
    if (latest) {
      await this.monitor.startMonitoring(latest.id, capital);
    }

    // Log to Trade Journal
    const journal = getTradeJournal();
    const spotPrice = this.marketState.getSpotPrice(underlying).toNumber();
    const ceStrike = candidate.ce.strike ?? 0;
    const peStrike = candidate.pe.strike ?? 0;
    const totalPremium = candidate.ceLtp + candidate.peLtp;
    const lotSize = getLotSize(underlying);

    // Calculate margin for logging
    const margin = calculateStrangleMargin(
      underlying, spotPrice, ceStrike, peStrike,
      candidate.ceLtp, candidate.peLtp, 1
    );

    // Get Greeks if available
    const greeks = this.positionManager.getNetGreeks();

    journal.logEntry({
      tradeId: latest?.id || `STR-${Date.now()}`,
      strategyType: 'SHORT_STRANGLE',
      underlying,
      entryDate: new Date().toISOString(),
      entrySpot: spotPrice,
      ceStrike,
      peStrike,
      cePremium: candidate.ceLtp,
      pePremium: candidate.peLtp,
      totalPremium: totalPremium * lotSize,
      lots: 1,
      marginUsed: margin.totalMargin,
      entryDelta: greeks.delta,
      entryTheta: greeks.theta,
      entryVega: greeks.vega,
      notes: `Auto-deployed via Telegram. Capital: ₹${capital.toLocaleString('en-IN')}`,
    });

    await this.bot.sendMessage(chatId,
      `✅ **Strangle Deployed!**\n\nSold ${ceStrike} CE & ${peStrike} PE\n\n📓 Logged to Trade Journal\n\nMonitoring active. Use Live Dashboard to track.`,
      { parse_mode: 'Markdown' }
    );

    logger.info('Strangle deployed via Telegram', {
      underlying,
      ceStrike,
      peStrike,
      capital
    });
  }

  // --- EXIT ALL ---
  private async confirmExitAll(chatId: number) {
    const positions = this.positionManager.getAllPositions();

    if (positions.length === 0) {
      await this.bot.sendMessage(chatId, "📊 No positions to close.");
      return;
    }

    await this.bot.sendMessage(chatId,
      `⚠️ **Confirm Exit All**\n\nThis will close ${positions.length} position(s).\n\nAre you sure?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚨 YES, EXIT ALL', callback_data: 'action_exit_confirmed' }],
            [{ text: '❌ Cancel', callback_data: 'menu_main' }]
          ]
        }
      });
  }

  private async emergencyExit(chatId: number) {
    const positions = this.positionManager.getAllPositions();

    if (positions.length === 0) {
      await this.bot.sendMessage(chatId, "📊 No positions to close.");
      return;
    }

    await this.bot.sendMessage(chatId, "🚨 **Closing all positions...**", { parse_mode: 'Markdown' });

    // Get open trades from journal before closing
    const journal = getTradeJournal();
    const openTrades = journal.getOpenTrades();

    let closedCount = 0;
    let ceExitPrice = 0;
    let peExitPrice = 0;

    for (const pos of positions) {
      try {
        const side = pos.side === 'LONG' ? 'SELL' : 'BUY';
        const order = await this.fillEngine.submitOrder({
          symbol: pos.symbol,
          underlying: pos.underlying,
          instrumentType: pos.instrumentType,
          strike: pos.strike ?? 0,
          expiry: pos.expiry,
          side,
          quantity: pos.quantity,
          orderType: 'MARKET'
        });

        if (order.status === 'FILLED') {
          this.positionManager.processOrderFill(order);
          closedCount++;

          // Track exit prices for journal
          if (pos.instrumentType === 'CE') {
            ceExitPrice = order.avgFillPrice?.toNumber() ?? 0;
          } else if (pos.instrumentType === 'PE') {
            peExitPrice = order.avgFillPrice?.toNumber() ?? 0;
          }
        }
      } catch (error) {
        logger.error('Failed to close position', { symbol: pos.symbol, error });
      }
    }

    const pnl = this.positionManager.getAggregatePnL();

    // Log exits to journal for matching open trades
    for (const trade of openTrades) {
      const spotPrice = this.marketState.getSpotPrice(trade.underlying).toNumber();
      journal.logExit(trade.tradeId, {
        exitDate: new Date().toISOString(),
        exitSpot: spotPrice,
        ceExitPrice,
        peExitPrice,
        exitReason: 'MANUAL',
        realizedPnL: pnl.realized.toNumber(),
      });
    }

    await this.bot.sendMessage(chatId,
      `✅ **Exit Complete**\n\nClosed ${closedCount} position(s)\nRealized P&L: ${formatINR(pnl.realized)}\n\n📓 Logged to Trade Journal`,
      { parse_mode: 'Markdown' }
    );

    logger.info('Emergency exit via Telegram', { closedCount, realizedPnL: pnl.realized.toString() });
  }

  // --- UTILITIES ---
  private getUptime(): string {
    const diff = Date.now() - this.startTime.getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }

  /**
   * Send notification to user (for external calls)
   */
  public async notify(message: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.allowedUser, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Failed to send Telegram notification', { error });
    }
  }

  /**
   * Send alert with sound
   */
  public async alert(message: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.allowedUser, `🚨 **ALERT**\n\n${message}`, {
        parse_mode: 'Markdown',
        disable_notification: false
      });
    } catch (error) {
      logger.error('Failed to send Telegram alert', { error });
    }
  }
}
