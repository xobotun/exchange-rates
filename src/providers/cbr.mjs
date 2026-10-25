import { HISTORY_START } from '../history.mjs';
import { fromDmy } from '../dates.mjs';
import { foreignPerHome, isQuote, parseDecimal } from '../normalize.mjs';
import { fetchDaily } from './daily.mjs';

// Central Bank of the Russian Federation, official rates (XML_daily).
// https://www.cbr.ru/development/SXML/
//
// Quirks:
// - windows-1251 XML, one date per request:
//   <ValCurs Date="DD.MM.YYYY"><Valute><CharCode>, <Nominal>, <Value>56,4250</Value>
//   — comma decimals, RUB per `Nominal` units. `VunitRate` (per 1 unit) is
//   newer and missing in old answers, so Value / Nominal is used throughout.
// - The answer is the rate IN FORCE on the requested date and its `Date` is
//   the day that rate applies from: rates are set on working days for the
//   next day, so Sunday and Monday answer with Saturday's rates, 1–9 Jan 2020
//   all answer with the rates of 01.01.2020, and a future date answers with
//   the newest rate. We key by `Date`, so those are duplicates.
// - GEL is quoted now (not in 2020); whatever the answer lists is kept.
// - No CORS. cbr.ru has been unreachable from some foreign networks at times;
//   if GitHub's runners are blocked, this provider fails on its own and the
//   others are still committed.

const URL_BASE = 'https://www.cbr.ru/scripts/XML_daily.asp';
const decoder = new TextDecoder('windows-1251');

/** @returns {{date: string, rates: Record<string, number>}} */
export function parse(body) {
  const text = Buffer.isBuffer(body) ? decoder.decode(body) : body;
  const head = /<ValCurs\s+Date="([^"]+)"/.exec(text);
  if (!head) throw new Error('not a CBR ValCurs document');
  const rates = {};
  for (const [, valute] of text.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)) {
    const field = (name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(valute)?.[1].trim();
    const code = field('CharCode');
    const units = parseDecimal(field('Nominal'));
    const quote = parseDecimal(field('Value'));
    if (!/^[A-Z]{3}$/.test(code ?? '') || !isQuote(quote) || !isQuote(units)) continue;
    rates[code.toLowerCase()] = foreignPerHome(quote, units);
  }
  return { date: fromDmy(head[1]), rates };
}

const definition = {
  id: 'cbr',
  ext: 'xml',
  url: (date) => `${URL_BASE}?date_req=${date.split('-').reverse().join('/')}`,
  parse,
};

export default {
  id: 'cbr',
  name: 'Central Bank of the Russian Federation',
  home: 'rub',
  source: 'https://www.cbr.ru/scripts/XML_daily.asp',
  firstDate: HISTORY_START,
  fetchRange: (from, to, ctx) => fetchDaily(definition, from, to, ctx),
};
