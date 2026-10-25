import { HISTORY_START } from '../history.mjs';
import { isIsoDate } from '../dates.mjs';
import { foreignPerHome, isQuote } from '../normalize.mjs';
import { fetchDaily } from './daily.mjs';

// National Bank of Georgia, official GEL exchange rates.
// https://nbg.gov.ge/en/monetary-policy/currency
//
// Quirks:
// - JSON, one date per request (no range endpoint found):
//   [{date, currencies: [{code, quantity, rate, validFromDate, …}]}].
// - `rate` is GEL per `quantity` units (100 KZT, 1000 AMD, 10000 IRR) and the
//   quantity can change over time (RSD: 10 in 2020, 100 in 2026), so it is
//   read from every answer.
// - The answer's top-level `date` is the date the rates are valid from. Until
//   about 2021 every calendar day had its own; now rates are set on working
//   days, valid from the next day, so a Sunday or Monday request returns
//   Saturday's rates dated Saturday (and so does any future date). We key by
//   that date, so those requests are duplicates of Saturday.

const URL_BASE = 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/';

/** @returns {{date: string, rates: Record<string, number>}} */
export function parse(json) {
  const data = JSON.parse(Buffer.isBuffer(json) ? json.toString('utf8') : json);
  if (!Array.isArray(data) || data.length !== 1) throw new Error('expected a one-element array');
  const [{ date, currencies }] = data;
  const day = String(date ?? '').slice(0, 10);
  if (!isIsoDate(day)) throw new Error(`bad date ${JSON.stringify(date)}`);
  if (!Array.isArray(currencies)) throw new Error('no currencies array');
  const rates = {};
  for (const { code, quantity, rate } of currencies) {
    if (!/^[A-Z]{3}$/.test(code ?? '') || !isQuote(rate) || !isQuote(quantity)) continue;
    rates[code.toLowerCase()] = foreignPerHome(rate, quantity);
  }
  return { date: day, rates };
}

const definition = {
  id: 'nbg',
  ext: 'json',
  url: (date) => `${URL_BASE}?date=${date}`,
  parse,
};

export default {
  id: 'nbg',
  name: 'National Bank of Georgia',
  home: 'gel',
  source: 'https://nbg.gov.ge/en/monetary-policy/currency',
  firstDate: HISTORY_START,
  fetchRange: (from, to, ctx) => fetchDaily(definition, from, to, ctx),
};
