import { HISTORY_START } from '../history.mjs';
import { fromDmy } from '../dates.mjs';
import { foreignPerHome, isQuote, parseDecimal } from '../normalize.mjs';
import { fetchDaily } from './daily.mjs';

// National Bank of Kazakhstan, official market exchange rates (RSS feed).
// https://nationalbank.kz/en/exchangerates/ezhednevnye-oficialnye-rynochnye-kursy-valyut
//
// Quirks:
// - One date per request: <rates><date>DD.MM.YYYY</date><item><title>CODE</title>
//   <description>rate</description><quant>n</quant></item>…</rates>, rate =
//   KZT per `quant` units (10 AMD, 100 UZS, 10000 IRR). The site's Excel
//   export covers a range in one request, but needs an unzip and internal
//   currency ids; the RSS keeps this dependency-free.
// - Every calendar day has its own rates (weekend days repeat the last set).
// - The feed echoes ANY requested date, including future ones, with the
//   newest known rates: never ask for a date after today (the updater caps
//   every run at today, UTC).
// - No CORS, so browsers cannot read it directly.
// - The feed has lost some days the bank did publish (2023-07-28..2023-08-28
//   except 08-22): it answers them with <info>на выбранную дату
//   информации нет.</info> ("no information for the selected date") and no
//   items. Such a day is no publication: its day file repeats the previous
//   one, the run warns about it, and scripts/nbk-excel-fill.mjs fills it from
//   NBK's Excel export (README "Maintenance notes").

const URL_BASE = 'https://nationalbank.kz/rss/get_rates.cfm';

/** True only for the answer "no information for the selected date": a dated feed with no items. */
export function isNoInformation(text) {
  return (
    !text.includes('<item>') &&
    /<info>\s*на выбранную дату информации нет\.\s*<\/info>/.test(text)
  );
}

/** @returns {{date: string, rates: Record<string, number>} | null} null for a day the feed has no information for */
export function parse(xml) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml;
  const dateMatch = /<date>([^<]*)<\/date>/.exec(text);
  if (!text.includes('<rates>') || !dateMatch) throw new Error('not an NBK rates feed');
  if (isNoInformation(text)) return null;
  const rates = {};
  for (const [, item] of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(item)?.[1].trim();
    const code = field('title');
    const quote = parseDecimal(field('description'));
    const units = parseDecimal(field('quant'));
    if (!/^[A-Z]{3}$/.test(code ?? '') || !isQuote(quote) || !isQuote(units)) continue;
    rates[code.toLowerCase()] = foreignPerHome(quote, units);
  }
  return { date: fromDmy(dateMatch[1]), rates };
}

const definition = {
  id: 'nbk',
  ext: 'xml',
  url: (date) => `${URL_BASE}?fdate=${date.split('-').reverse().join('.')}`,
  parse,
};

export default {
  id: 'nbk',
  name: 'National Bank of Kazakhstan',
  home: 'kzt',
  source: 'https://nationalbank.kz/rss/get_rates.cfm',
  firstDate: HISTORY_START,
  fetchRange: (from, to, ctx) => fetchDaily(definition, from, to, ctx),
};
