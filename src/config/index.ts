/**
 * Configuration Management for NSE Options Paper Trading
 *
 * Loads configuration from environment variables and config files.
 * Validates configuration using Zod schemas.
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ConfigurationError, MissingConfigError, InvalidConfigError } from '../core/errors.js';
import { logger } from '../utils/logger.js';
import type { SystemConfig } from '../core/types.js';

// Load environment variables
dotenv.config();

// ============================================================================
// CONFIGURATION SCHEMA
// ============================================================================

const zerodhaConfigSchema = z.object({
  apiKey: z.string().min(1, 'Zerodha API key is required'),
  apiSecret: z.string().min(1, 'Zerodha API secret is required'),
  accessToken: z.string().min(1, 'Zerodha access token is required'),
  userId: z.string().min(1, 'Zerodha user ID is required'),
});

const tradingConfigSchema = z.object({
  underlyings: z.array(z.enum(['NIFTY', 'BANKNIFTY', 'FINNIFTY'])).default(['NIFTY', 'BANKNIFTY']),
  strikesAroundATM: z.number().min(1).max(20).default(10),
  expiryWeeks: z.number().min(1).max(4).default(2),
  tradingStartTime: z.string().regex(/^\d{2}:\d{2}$/).default('09:15'),
  tradingEndTime: z.string().regex(/^\d{2}:\d{2}$/).default('15:30'),
});

const executionConfigSchema = z.object({
  latencyMinMs: z.number().min(0).max(5000).default(100),
  latencyMaxMs: z.number().min(100).max(10000).default(500),
  baseSlippage: z.number().min(0).max(1).default(0.05),
  velocitySlippageMultiplier: z.number().min(0).max(10).default(0.01),
  ivSlippageMultiplier: z.number().min(0).max(10).default(0.02),
  sizeSlippageMultiplier: z.number().min(0).max(10).default(0.10),
  depthSlippageMultiplier: z.number().min(0).max(10).default(0.50),
});

const riskConfigSchema = z.object({
  initialCapital: z.number().min(10000).default(500000),
  maxDailyLoss: z.number().min(1000).default(50000),
  maxDailyLossPct: z.number().min(0.01).max(0.5).default(0.05),
  marginBreachThreshold: z.number().min(0.5).max(1).default(0.90),
  forceExitOnBreach: z.boolean().default(true),
  expiryDayMarginMultiplier: z.number().min(1).max(3).default(1.5),
});

const databaseConfigSchema = z.object({
  path: z.string().default('./data/paper-trading.db'),
  backupEnabled: z.boolean().default(true),
  backupIntervalMinutes: z.number().min(5).default(60),
});

const webhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().min(1).max(65535).default(3000),
  secret: z.string().default(''),
  allowedIPs: z.array(z.string()).default([]),
});

const systemConfigSchema = z.object({
  zerodha: zerodhaConfigSchema,
  trading: tradingConfigSchema,
  execution: executionConfigSchema,
  risk: riskConfigSchema,
  database: databaseConfigSchema,
  webhook: webhookConfigSchema,
});

// ============================================================================
// CONFIGURATION LOADING
// ============================================================================

let cachedConfig: SystemConfig | null = null;

/**
 * Load configuration from environment and config file
 */
export function loadConfig(forceReload = false): SystemConfig {
  if (cachedConfig && !forceReload) {
    return cachedConfig;
  }

  logger.debug('Loading configuration...');

  // Build config object from environment
  const rawConfig = {
    zerodha: {
      apiKey: process.env['KITE_API_KEY'] ?? '',
      apiSecret: process.env['KITE_API_SECRET'] ?? '',
      accessToken: process.env['KITE_ACCESS_TOKEN'] ?? '',
      userId: process.env['KITE_USER_ID'] ?? '',
    },
    trading: {
      underlyings: parseEnvArray(process.env['TRADING_UNDERLYINGS']) ?? ['NIFTY', 'BANKNIFTY'],
      strikesAroundATM: parseEnvNumber(process.env['TRADING_STRIKES_AROUND_ATM']) ?? 10,
      expiryWeeks: parseEnvNumber(process.env['TRADING_EXPIRY_WEEKS']) ?? 2,
      tradingStartTime: process.env['TRADING_START_TIME'] ?? '09:15',
      tradingEndTime: process.env['TRADING_END_TIME'] ?? '15:30',
    },
    execution: {
      latencyMinMs: parseEnvNumber(process.env['EXECUTION_LATENCY_MIN_MS']) ?? 100,
      latencyMaxMs: parseEnvNumber(process.env['EXECUTION_LATENCY_MAX_MS']) ?? 500,
      baseSlippage: parseEnvNumber(process.env['EXECUTION_BASE_SLIPPAGE']) ?? 0.05,
      velocitySlippageMultiplier: parseEnvNumber(process.env['EXECUTION_VELOCITY_SLIPPAGE_MULTIPLIER']) ?? 0.01,
      ivSlippageMultiplier: parseEnvNumber(process.env['EXECUTION_IV_SLIPPAGE_MULTIPLIER']) ?? 0.02,
      sizeSlippageMultiplier: parseEnvNumber(process.env['EXECUTION_SIZE_SLIPPAGE_MULTIPLIER']) ?? 0.10,
      depthSlippageMultiplier: parseEnvNumber(process.env['EXECUTION_DEPTH_SLIPPAGE_MULTIPLIER']) ?? 0.50,
    },
    risk: {
      initialCapital: parseEnvNumber(process.env['RISK_INITIAL_CAPITAL']) ?? 500000,
      maxDailyLoss: parseEnvNumber(process.env['RISK_MAX_DAILY_LOSS']) ?? 50000,
      maxDailyLossPct: parseEnvNumber(process.env['RISK_MAX_DAILY_LOSS_PCT']) ?? 0.05,
      marginBreachThreshold: parseEnvNumber(process.env['RISK_MARGIN_BREACH_THRESHOLD']) ?? 0.90,
      forceExitOnBreach: parseEnvBoolean(process.env['RISK_FORCE_EXIT_ON_BREACH']) ?? true,
      expiryDayMarginMultiplier: parseEnvNumber(process.env['RISK_EXPIRY_DAY_MARGIN_MULTIPLIER']) ?? 1.5,
    },
    database: {
      path: process.env['DATABASE_PATH'] ?? './data/paper-trading.db',
      backupEnabled: parseEnvBoolean(process.env['DATABASE_BACKUP_ENABLED']) ?? true,
      backupIntervalMinutes: parseEnvNumber(process.env['DATABASE_BACKUP_INTERVAL_MINUTES']) ?? 60,
    },
    webhook: {
      enabled: parseEnvBoolean(process.env['WEBHOOK_ENABLED']) ?? false,
      port: parseEnvNumber(process.env['WEBHOOK_PORT']) ?? 3000,
      secret: process.env['WEBHOOK_SECRET'] ?? '',
      allowedIPs: parseEnvArray(process.env['WEBHOOK_ALLOWED_IPS']) ?? [],
    },
  };

  // Load config file if exists
  const configPath = process.env['CONFIG_PATH'] ?? './config/default.json';
  if (existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      Object.assign(rawConfig, deepMerge(rawConfig, fileConfig));
      logger.debug(`Loaded config file: ${configPath}`);
    } catch (error) {
      logger.warn(`Failed to load config file: ${configPath}`, { error });
    }
  }

  // Validate
  const result = systemConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigurationError(`Invalid configuration:\n${errors.join('\n')}`);
  }

  cachedConfig = result.data as SystemConfig;

  logger.info('Configuration loaded', {
    underlyings: cachedConfig.trading.underlyings,
    initialCapital: cachedConfig.risk.initialCapital,
    webhookEnabled: cachedConfig.webhook.enabled,
  });

  return cachedConfig;
}

/**
 * Get current config (throws if not loaded)
 */
export function getConfig(): SystemConfig {
  if (!cachedConfig) {
    throw new ConfigurationError('Configuration not loaded. Call loadConfig() first.');
  }
  return cachedConfig;
}

/**
 * Validate Zerodha credentials
 */
export function validateZerodhaConfig(): void {
  const config = getConfig();

  if (!config.zerodha.apiKey) {
    throw new MissingConfigError('KITE_API_KEY');
  }
  if (!config.zerodha.apiSecret) {
    throw new MissingConfigError('KITE_API_SECRET');
  }
  if (!config.zerodha.accessToken) {
    throw new MissingConfigError('KITE_ACCESS_TOKEN');
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function parseEnvNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  return isNaN(num) ? undefined : num;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseEnvArray(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

// ============================================================================
// DEFAULT CONFIG FILE
// ============================================================================

export const defaultConfigFile = `{
  "trading": {
    "underlyings": ["NIFTY", "BANKNIFTY"],
    "strikesAroundATM": 10,
    "expiryWeeks": 2
  },
  "execution": {
    "latencyMinMs": 100,
    "latencyMaxMs": 500,
    "baseSlippage": 0.05
  },
  "risk": {
    "initialCapital": 500000,
    "maxDailyLoss": 50000,
    "maxDailyLossPct": 0.05,
    "marginBreachThreshold": 0.90,
    "forceExitOnBreach": true
  },
  "webhook": {
    "enabled": false,
    "port": 3000
  }
}`;
