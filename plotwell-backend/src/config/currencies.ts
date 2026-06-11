// Single-currency pricing configuration (USD only)
// Stripe handles currency conversion and deposits in EUR to Spanish bank account

export type CurrencyCode = 'USD';

export interface CurrencyConfig {
  code: CurrencyCode;
  symbol: string;
  symbolPosition: 'before' | 'after';
  decimals: number;
  stripeCurrency: string; // lowercase for Stripe API
}

export const CURRENCIES: Record<CurrencyCode, CurrencyConfig> = {
  USD: { code: 'USD', symbol: '$', symbolPosition: 'before', decimals: 2, stripeCurrency: 'usd' },
};

// Pricing table: all amounts in dollars - NOT cents
export interface CurrencyPriceTable {
  pro_monthly: number;
  pro_yearly: number;
  addon_project_monthly: number;
  addon_project_yearly: number;
  addon_collaborator_monthly: number;
  addon_collaborator_yearly: number;
  credits_small: number;       // base unit price
  credits_small_cents: number; // cents for Stripe
  credits_large: number;
  credits_large_cents: number;
  credits_bulk: number;
  credits_bulk_cents: number;
}

export const CURRENCY_PRICES: Record<CurrencyCode, CurrencyPriceTable> = {
  USD: {
    pro_monthly: 5,
    pro_yearly: 50,
    addon_project_monthly: 3,
    addon_project_yearly: 30,
    addon_collaborator_monthly: 3,
    addon_collaborator_yearly: 30,
    credits_small: 5,
    credits_small_cents: 500,
    credits_large: 10,
    credits_large_cents: 1000,
    credits_bulk: 20,
    credits_bulk_cents: 2000,
  },
};

/**
 * Get the price table for a given currency code.
 * Always returns USD (single currency).
 */
export function getPricesForCurrency(_currency?: string): CurrencyPriceTable {
  return CURRENCY_PRICES.USD;
}

/**
 * Get full currency config. Always returns USD.
 */
export function getCurrencyConfig(_currency?: string): CurrencyConfig {
  return CURRENCIES.USD;
}

/**
 * Format a price with currency symbol (for backend use, e.g. emails/logs).
 * For frontend, use Intl.NumberFormat instead.
 */
export function formatPrice(amount: number, _currency?: CurrencyCode): string {
  const formatted = amount.toFixed(2);
  return `$${formatted}`;
}

/**
 * Detect currency from an Express request.
 * Always returns USD (single currency model).
 */
export function detectCurrencyFromRequest(_req: { query?: any; headers?: any }): CurrencyCode {
  return 'USD';
}
