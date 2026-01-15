/**
 * Margin Calculator for NSE F&O (NIFTY/BANKNIFTY)
 *
 * This is an APPROXIMATION for paper trading and learning.
 * Real margin = SPAN + Exposure (calculated by NSE using 16 risk scenarios)
 *
 * For actual trading, always check broker's margin calculator.
 */

import type { Underlying } from '../core/types.js';

// Lot sizes (as of 2024)
const LOT_SIZES: Record<Underlying, number> = {
  NIFTY: 25,      // Changed from 50 to 25 in April 2024
  BANKNIFTY: 15,  // Changed from 30 to 15 in April 2024
  FINNIFTY: 25,
};

// Approximate margin percentages (these vary based on volatility)
const MARGIN_CONFIG = {
  // SPAN margin as % of contract value
  spanPercent: 0.09,      // ~9% base SPAN
  // Exposure margin as % of contract value
  exposurePercent: 0.03,  // ~3% exposure
  // Additional margin for short options
  shortOptionExtra: 0.02, // ~2% extra for short options
  // Margin benefit for spreads/strangles (both legs can't be ITM)
  strangleBenefit: 0.30,  // ~30% reduction for strangle
};

export interface MarginEstimate {
  spanMargin: number;
  exposureMargin: number;
  totalMargin: number;
  premiumReceived: number;
  netMarginBlocked: number;  // Total margin - Premium received
  roi: number;               // Premium / Net Margin as %
  maxLoss: string;           // Theoretical max loss
}

export interface PositionMarginInput {
  underlying: Underlying;
  spotPrice: number;
  strike: number;
  optionType: 'CE' | 'PE';
  premium: number;          // LTP of option
  quantity: number;         // Number of lots (negative for short)
  isShort: boolean;
}

/**
 * Calculate margin for a single option position
 */
export function calculateOptionMargin(input: PositionMarginInput): MarginEstimate {
  const { underlying, spotPrice, strike, optionType, premium, quantity, isShort } = input;

  const lotSize = LOT_SIZES[underlying] || 50;
  const lots = Math.abs(quantity);
  const contractValue = spotPrice * lotSize * lots;

  let spanMargin = 0;
  let exposureMargin = 0;

  if (isShort) {
    // Short options require margin
    // SPAN approximation: higher of premium-based or % of underlying
    const premiumComponent = premium * lotSize * lots;
    const underlyingComponent = contractValue * MARGIN_CONFIG.spanPercent;

    // For OTM options, margin is generally lower
    const moneyness = optionType === 'CE'
      ? (strike - spotPrice) / spotPrice
      : (spotPrice - strike) / spotPrice;

    // OTM options get some reduction (capped at 30% reduction)
    const otmReduction = Math.max(0, Math.min(0.30, moneyness * 2));

    spanMargin = Math.max(premiumComponent * 2, underlyingComponent) * (1 - otmReduction);
    spanMargin += contractValue * MARGIN_CONFIG.shortOptionExtra;

    exposureMargin = contractValue * MARGIN_CONFIG.exposurePercent;
  } else {
    // Long options only need premium (debit)
    spanMargin = premium * lotSize * lots;
    exposureMargin = 0;
  }

  const totalMargin = spanMargin + exposureMargin;
  const premiumReceived = isShort ? premium * lotSize * lots : 0;
  const netMarginBlocked = totalMargin - premiumReceived;
  const roi = netMarginBlocked > 0 ? (premiumReceived / netMarginBlocked) * 100 : 0;

  return {
    spanMargin: Math.round(spanMargin),
    exposureMargin: Math.round(exposureMargin),
    totalMargin: Math.round(totalMargin),
    premiumReceived: Math.round(premiumReceived),
    netMarginBlocked: Math.round(netMarginBlocked),
    roi: Math.round(roi * 100) / 100,
    maxLoss: isShort ? 'Unlimited' : `₹${Math.round(premiumReceived)}`,
  };
}

/**
 * Calculate margin for a short strangle (Sell CE + Sell PE)
 */
export function calculateStrangleMargin(
  underlying: Underlying,
  spotPrice: number,
  ceStrike: number,
  peStrike: number,
  cePremium: number,
  pePremium: number,
  lots: number = 1
): MarginEstimate & { ceMargin: number; peMargin: number; marginBenefit: number } {

  // Calculate individual leg margins
  const ceMarginData = calculateOptionMargin({
    underlying,
    spotPrice,
    strike: ceStrike,
    optionType: 'CE',
    premium: cePremium,
    quantity: lots,
    isShort: true,
  });

  const peMarginData = calculateOptionMargin({
    underlying,
    spotPrice,
    strike: peStrike,
    optionType: 'PE',
    premium: pePremium,
    quantity: lots,
    isShort: true,
  });

  // Combined margin before benefit
  const combinedMargin = ceMarginData.totalMargin + peMarginData.totalMargin;

  // Strangle benefit: Both legs can't be ITM simultaneously
  // Take the higher margin leg + reduced margin of lower leg
  const higherMargin = Math.max(ceMarginData.totalMargin, peMarginData.totalMargin);
  const lowerMargin = Math.min(ceMarginData.totalMargin, peMarginData.totalMargin);

  // Benefit calculation: ~30% reduction on lower leg
  const marginBenefit = lowerMargin * MARGIN_CONFIG.strangleBenefit;
  const totalMargin = combinedMargin - marginBenefit;

  const totalPremium = ceMarginData.premiumReceived + peMarginData.premiumReceived;
  const netMarginBlocked = totalMargin - totalPremium;
  const roi = netMarginBlocked > 0 ? (totalPremium / netMarginBlocked) * 100 : 0;

  // Calculate breakeven points
  const lotSize = LOT_SIZES[underlying] || 50;
  const totalPremiumPerLot = cePremium + pePremium;
  const upperBreakeven = ceStrike + totalPremiumPerLot;
  const lowerBreakeven = peStrike - totalPremiumPerLot;

  return {
    spanMargin: Math.round(totalMargin * 0.75), // Approximate split
    exposureMargin: Math.round(totalMargin * 0.25),
    totalMargin: Math.round(totalMargin),
    premiumReceived: Math.round(totalPremium),
    netMarginBlocked: Math.round(netMarginBlocked),
    roi: Math.round(roi * 100) / 100,
    maxLoss: 'Unlimited (beyond breakevens)',
    ceMargin: Math.round(ceMarginData.totalMargin),
    peMargin: Math.round(peMarginData.totalMargin),
    marginBenefit: Math.round(marginBenefit),
  };
}

/**
 * Format margin data for display
 */
export function formatMarginDisplay(
  margin: MarginEstimate,
  underlying: Underlying,
  isStrangle: boolean = false
): string {
  const lotSize = LOT_SIZES[underlying] || 50;

  let display = `
💰 **Margin Estimate**
━━━━━━━━━━━━━━━━━━━━━
SPAN Margin:     ₹${margin.spanMargin.toLocaleString('en-IN')}
Exposure Margin: ₹${margin.exposureMargin.toLocaleString('en-IN')}
━━━━━━━━━━━━━━━━━━━━━
**Total Margin:  ₹${margin.totalMargin.toLocaleString('en-IN')}**

Premium Received: ₹${margin.premiumReceived.toLocaleString('en-IN')}
Net Capital Blocked: ₹${margin.netMarginBlocked.toLocaleString('en-IN')}

📊 **ROI: ${margin.roi}%** (if expires worthless)
⚠️ Max Loss: ${margin.maxLoss}
`;

  if (isStrangle) {
    display += `
📝 _Strangle margin benefit applied_
_Both legs can't be ITM simultaneously_
`;
  }

  display += `
━━━━━━━━━━━━━━━━━━━━━
_Lot Size: ${lotSize} | Approximate values_
_For actual margin, check broker_
`;

  return display;
}

/**
 * Get lot size for underlying
 */
export function getLotSize(underlying: Underlying): number {
  return LOT_SIZES[underlying] || 50;
}
