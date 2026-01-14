/**
 * Options Pricing Module Exports
 */

// Black-Scholes
export {
  normCDF,
  normPDF,
  calculateD1D2,
  calculateCallPrice,
  calculatePutPrice,
  calculateOptionPrice,
  calculateGreeks,
  calculateDelta,
  calculateGamma,
  calculateVega,
  calculateIntrinsicValue,
  calculateExtrinsicValue,
  calculateMoneyness,
  isITM,
  isATM,
  isOTM,
} from './black-scholes.js';

// IV Calculator
export {
  calculateIV,
  calculateIVBisection,
  calculateIVWithApproximation,
  calculateIVSurface,
  getATMIV,
  getIVSkew,
  interpolateIV,
} from './iv-calculator.js';
export type { IVPoint, IVSurface } from './iv-calculator.js';

// Seller Pain
export {
  calculateInflatedIV,
  calculateSellerPain,
  calculateStrategyPain,
  calculateExpiryGammaPain,
} from './seller-pain.js';
export type { SellerPain, StrategyPain } from './seller-pain.js';
