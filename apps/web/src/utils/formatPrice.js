// Map ISO 4217 currency codes to symbols for stores that don't support
// Intl.NumberFormat properly (older browsers, edge runtimes). Intl handles
// 95%+ of cases — this is just a defensive fallback.
const CURRENCY_SYMBOLS = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  CAD: "C$",
  AUD: "A$",
  JPY: "¥",
  CNY: "¥",
  KRW: "₩",
  RUB: "₽",
  BRL: "R$",
  MXN: "Mex$",
  CHF: "CHF",
  SEK: "kr",
  NOK: "kr",
  DKK: "kr",
  PLN: "zł",
  TRY: "₺",
  AED: "د.إ",
  SAR: "﷼",
  ZAR: "R",
  THB: "฿",
  SGD: "S$",
  HKD: "HK$",
  NZD: "NZ$",
};

/**
 * Format a numeric price for display using the store's currency.
 * Falls back to USD if currency is missing (legacy cached payloads).
 *
 * @param {number|string} value
 * @param {string} [currency="USD"]
 * @returns {string}
 */
export function formatPrice(value, currency = "USD") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const code = (currency || "USD").toUpperCase();

  // INR / JPY / KRW etc. typically don't show decimals.
  // For very large amounts we drop decimals as well.
  const noDecimals = ["INR", "JPY", "KRW", "VND", "CLP", "ISK"].includes(code) || n >= 1000;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: noDecimals ? 0 : 2,
      minimumFractionDigits: noDecimals ? 0 : 2,
    }).format(n);
  } catch {
    const symbol = CURRENCY_SYMBOLS[code] || code + " ";
    const rounded = noDecimals ? Math.round(n) : n.toFixed(2);
    return `${symbol}${Number(rounded).toLocaleString("en-US")}`;
  }
}
