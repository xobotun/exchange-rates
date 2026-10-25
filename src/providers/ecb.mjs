import { HISTORY_START } from '../history.mjs';
import { addDays, yearOf } from '../dates.mjs';
import { isQuote, parseDecimal } from '../normalize.mjs';

// European Central Bank euro reference rates.
// https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html
//
// Quirks:
// - Working days only (TARGET calendar): no weekend rows, no rows on
//   1 Jan, Good Friday, Easter Monday, 1 May, 25/26 Dec.
// - Published around 16:00 CET.
// - Quotes are already "foreign per 1 EUR": no division, no inversion.
// - The files serve the whole history (eurofxref-hist.xml, ~8 MB, from
//   1999-01-04) or the last ~90 days (eurofxref-hist-90d.xml, ~70 KB); there
//   is no range query. We take the 90-day file when it reaches back far
//   enough and download the full history at most once per run otherwise.
// - The daily and 90-day files differ cosmetically (single vs double quotes,
//   trailing zeros); the parser accepts both.

const BASE = 'https://www.ecb.europa.eu/stats/eurofxref/';
const LOOKBACK_DAYS = 21; // longest ECB gap is the 4-day Easter weekend

/**
 * Parses an ECB eurofxref XML file (daily, 90-day or full history).
 * @returns {{date: string, rates: Record<string, number>}[]} oldest first
 */
export function parse(xml) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml;
  if (!text.includes('eurofxref')) throw new Error('not an ECB eurofxref document');
  const publications = [];
  const dayCube = /<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']\s*>([\s\S]*?)<\/Cube>/g;
  const rateCube = /<Cube\s+currency=["']([A-Z]{3})["']\s+rate=["']([^"']*)["']\s*\/>/g;
  for (const [, date, inner] of text.matchAll(dayCube)) {
    const rates = {};
    for (const [, code, value] of inner.matchAll(rateCube)) {
      const n = parseDecimal(value);
      if (isQuote(n)) rates[code.toLowerCase()] = n;
    }
    publications.push({ date, rates });
  }
  if (publications.length === 0) throw new Error('no <Cube time=…> publications found');
  return publications.sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function download(file, ctx) {
  const key = `ecb:${file}`;
  if (!ctx.cache.has(key)) {
    // Cache the promise, so year chunks of one backfill share one download.
    const pending = ctx.http.get(BASE + file).then((body) => ({ file, body, publications: parse(body) }));
    pending.catch(() => ctx.cache.delete(key));
    ctx.cache.set(key, pending);
  }
  return ctx.cache.get(key);
}

async function fetchRange(from, to, ctx) {
  const needFrom = addDays(from, -LOOKBACK_DAYS);
  let doc = await download('eurofxref-hist-90d.xml', ctx);
  if (doc.publications[0].date > needFrom) doc = await download('eurofxref-hist.xml', ctx);
  const newest = doc.publications.at(-1).date;
  return {
    publications: doc.publications.filter((p) => p.date >= needFrom && p.date <= to),
    // Stable name per year: the nightly overwrites it, git history keeps every version.
    raw: [{ path: `raw/ecb/${yearOf(newest)}/${doc.file}`, body: doc.body }],
  };
}

export default {
  id: 'ecb',
  name: 'European Central Bank',
  home: 'eur',
  source: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml',
  firstDate: HISTORY_START,
  fetchRange,
};
