# NSE Options Paper Trading System

A near-realistic options paper trading system for Indian NSE markets (NIFTY/BANKNIFTY/FINNIFTY) with Zerodha Kite Connect integration, Telegram bot control, and Docker support.

## Features

- Real-time market data via Zerodha Kite WebSocket
- Realistic order execution with slippage simulation
- Multi-leg strategies (straddles, strangles, spreads)
- Risk management with kill switches
- Telegram bot for remote trading control
- Docker containerization for easy deployment

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Zerodha Setup](#zerodha-setup)
3. [Telegram Bot Setup](#telegram-bot-setup)
4. [Local Installation](#local-installation)
5. [Docker Setup](#docker-setup)
6. [Configuration](#configuration)
7. [Usage](#usage)
8. [Telegram Commands](#telegram-commands)

---

## Prerequisites

- Node.js 20+ (for local development)
- Docker (for containerized deployment)
- Zerodha Kite Connect API subscription
- Telegram account

---

## Zerodha Setup

### Step 1: Get Kite Connect API Access

1. Go to [Kite Connect](https://kite.trade/)
2. Sign up for a developer account
3. Create a new app to get:
   - **API Key**
   - **API Secret**

### Step 2: Set Redirect URL

In your Kite Connect app settings, set the redirect URL to:
```
http://localhost:3000/callback
```

### Step 3: Generate Request Token

1. Visit the login URL:
   ```
   https://kite.zerodha.com/connect/login?v=3&api_key=YOUR_API_KEY
   ```
2. Login with your Zerodha credentials
3. After redirect, copy the `request_token` from the URL

---

## Telegram Bot Setup

### Step 1: Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` command
3. Follow the prompts:
   - Enter a name for your bot (e.g., "NSE Paper Trading Bot")
   - Enter a username for your bot (must end with `bot`, e.g., "nse_paper_trading_bot")
4. **Save the Bot Token** - You'll receive a message like:
   ```
   Done! Congratulations on your new bot. You will find it at t.me/your_bot_username.
   Use this token to access the HTTP API:
   123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   ```

### Step 2: Get Your Telegram User ID

1. Open Telegram and search for **@userinfobot**
2. Send `/start` command
3. The bot will reply with your user info:
   ```
   Id: 123456789
   First: Your Name
   Lang: en
   ```
4. **Save your User ID** (the number after "Id:")

### Step 3: Start Your Bot

1. Search for your bot by its username
2. Click **Start** or send `/start`
3. Your bot is now ready to receive commands

---

## Local Installation

### Step 1: Clone the Repository

```bash
git clone https://github.com/DevSecOps-Stack/options-ind-trade.git
cd options-ind-trade
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Configure Environment

```bash
# Copy example env file
cp .env.example .env

# Edit with your credentials
nano .env  # or use any text editor
```

Required environment variables:
```env
# Zerodha Credentials
ZERODHA_API_KEY=your_api_key
ZERODHA_API_SECRET=your_api_secret
ZERODHA_USER_ID=your_zerodha_user_id

# Telegram Bot
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=your_telegram_user_id

# Trading Config
INITIAL_CAPITAL=500000
DEFAULT_UNDERLYING=NIFTY
```

### Step 4: Build and Run

```bash
# Build TypeScript
npm run build

# Run CLI
npm run cli

# Or run in development mode
npm run dev
```

---

## Docker Setup

### Step 1: Build Docker Image

```bash
# Using npm script
npm run docker:build

# Or using docker directly
docker build -t nse-paper-trading .
```

### Step 2: Create Data Directory

```bash
mkdir -p data
```

### Step 3: Configure Environment

```bash
# Copy and edit .env file
cp .env.example .env
nano .env
```

### Step 4: Run Container

**Interactive Mode (recommended for first run):**
```bash
docker run -it --rm \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  nse-paper-trading
```

**Detached Mode (background):**
```bash
docker run -d \
  --name nse-trader \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -p 3000:3000 \
  --restart unless-stopped \
  nse-paper-trading
```

### Step 5: View Logs

```bash
# Follow logs
docker logs -f nse-trader

# Or using npm script
npm run docker:logs
```

### Step 6: Stop Container

```bash
docker stop nse-trader
docker rm nse-trader

# Or using npm script
npm run docker:stop
```

---

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ZERODHA_API_KEY` | Kite Connect API Key | Yes |
| `ZERODHA_API_SECRET` | Kite Connect API Secret | Yes |
| `ZERODHA_USER_ID` | Your Zerodha User ID | Yes |
| `ZERODHA_ACCESS_TOKEN` | Saved access token (auto-managed) | No |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token from BotFather | Yes |
| `TELEGRAM_CHAT_ID` | Your Telegram User ID | Yes |
| `INITIAL_CAPITAL` | Starting paper trading capital | No (default: 500000) |
| `DEFAULT_UNDERLYING` | Default index (NIFTY/BANKNIFTY) | No (default: NIFTY) |
| `LOG_LEVEL` | Logging level (debug/info/warn/error) | No (default: info) |

### Risk Management Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `DAILY_LOSS_LIMIT` | Max daily loss before kill switch | 50000 |
| `MAX_POSITION_SIZE` | Max lots per position | 10 |
| `MARGIN_UTILIZATION_LIMIT` | Max margin usage (0-1) | 0.8 |

---

## Usage

### First Time Login

1. Start the application (local or Docker)
2. Open Telegram and message your bot
3. Get the login URL from console or use:
   ```
   https://kite.zerodha.com/connect/login?v=3&api_key=YOUR_API_KEY
   ```
4. Complete Zerodha login
5. Copy the `request_token` from redirect URL
6. Send to bot: `/login YOUR_REQUEST_TOKEN`

### Daily Login

Zerodha tokens expire daily. Each trading day:
1. Visit the login URL
2. Get new request token
3. Send `/login YOUR_REQUEST_TOKEN` to bot

---

## Telegram Commands

### General Commands

| Command | Description |
|---------|-------------|
| `/start` | Show main menu with buttons |
| `/help` | List all available commands |
| `/status` | System status and uptime |
| `/login <token>` | Login with Zerodha request token |

### Position & P&L Commands

| Command | Description |
|---------|-------------|
| `/positions` | View all open positions |
| `/pnl` | View P&L summary |
| `/greeks` | View net Greeks (Delta, Gamma, Theta, Vega) |
| `/strategies` | View active trading strategies |
| `/spot` | View NIFTY/BANKNIFTY spot prices |

### Trading Actions (via Menu)

- **LIVE Dashboard** - Real-time P&L updates (auto-refresh)
- **NIFTY Strangle** - Auto-deploy NIFTY strangle
- **BANKNIFTY Strangle** - Auto-deploy BANKNIFTY strangle
- **EXIT ALL** - Emergency close all positions

### Example Workflow

```
1. /start           → Opens main menu
2. Click "NIFTY Strangle"
3. Select capital (1L/2L/5L or type amount)
4. Review strangle details
5. Click "EXECUTE" to deploy
6. Click "LIVE Dashboard" to monitor
7. Use "EXIT ALL" if needed
```

---

## Project Structure

```
options-ind-trade/
├── src/
│   ├── cli/              # CLI and Telegram bot
│   ├── core/             # Types, constants, errors
│   ├── market-data/      # WebSocket, market state
│   ├── pricing/          # Black-Scholes, IV calculation
│   ├── execution/        # Order fill simulation
│   ├── risk/             # Kill switch, margin tracking
│   ├── position/         # Position management
│   ├── strategies/       # Auto-strangle, monitoring
│   ├── api/              # Webhook server
│   └── utils/            # Logger, helpers
├── config/               # Configuration files
├── data/                 # SQLite database (gitignored)
├── Dockerfile            # Container build
├── .env.example          # Environment template
└── package.json
```

---

## Troubleshooting

### "No instruments in memory"
- Ensure you've logged in with a valid request token
- Check if market hours (9:15 AM - 3:30 PM IST)

### Telegram bot not responding
- Verify `TELEGRAM_BOT_TOKEN` is correct
- Verify `TELEGRAM_CHAT_ID` matches your user ID
- Ensure you've clicked "Start" on the bot

### Docker .env file issues (ETELEGRAM: 404 Not Found)

If the bot works with explicit `-e` flags but not with `--env-file .env`:

**1. Verify .env file exists:**
```bash
ls -la .env
# If missing, create it:
cp .env.example .env
```

**2. Check .env file format (IMPORTANT):**
```bash
# .env must NOT have quotes around values
# WRONG:
TELEGRAM_BOT_TOKEN="123456:ABC..."  # Quotes included literally!

# CORRECT:
TELEGRAM_BOT_TOKEN=123456:ABC...
```

**3. Test with explicit flags first:**
```bash
docker run -it --rm \
  -e TELEGRAM_BOT_TOKEN=your_token \
  -e TELEGRAM_CHAT_ID=your_id \
  -v $(pwd)/data:/app/data \
  nse-paper-trading
```

**4. Debug .env loading:**
```bash
# Show what Docker will see:
docker run --rm --env-file .env alpine env | grep TELEGRAM
```

**5. Common .env issues:**
- Quotes around values (Docker includes them literally)
- Spaces around `=` sign (not allowed)
- Windows line endings (`\r\n`) - convert with `dos2unix .env`
- Missing required variables

### Docker build fails
- Ensure Docker is installed and running
- Try: `docker system prune` to clear cache
- Check Node.js version compatibility

### WebSocket disconnects
- Check internet connection
- Verify Zerodha API subscription is active
- Check if access token has expired (re-login)

---

## License

MIT License - See [LICENSE](LICENSE) file

---

## Disclaimer

This is a **paper trading** system for educational purposes. No real money is involved. Always test thoroughly before any live trading. The authors are not responsible for any financial losses.
