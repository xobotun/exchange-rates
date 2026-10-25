// Turning a bank's quote into the published number: how many units of the
// foreign code ONE unit of the home currency buys (fawazahmed0's shape).

/**
 * For banks that quote "home per `units` foreign" (CBA, NBG, NBK, CBR):
 * "AMD 79.608 per 10 KZT" → 10 / 79.608 KZT per 1 AMD. One IEEE division, so
 * the result is the correctly rounded double of the exact ratio — full
 * precision, no rounding of our own.
 */
export function foreignPerHome(quote, units = 1) {
  return units / quote;
}

/** Grams in one troy ounce (exact by definition). ISO 4217 XAU / XAG / XPT / XPD are one troy ounce. */
export const GRAMS_PER_TROY_OUNCE = 31.1034768;

/**
 * Parses a bank's decimal string: '56,4250' (CBR) or '1.1193' (ECB). Returns
 * NaN for anything that is not a plain decimal, so callers can skip it.
 */
export function parseDecimal(s) {
  const t = String(s ?? '').trim().replace(',', '.');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** A usable quote: a finite number above zero (banks write 0 or '' for "not quoted"). */
export const isQuote = (n) => Number.isFinite(n) && n > 0;
