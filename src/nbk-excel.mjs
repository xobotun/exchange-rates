// NBK's Excel export, as a fallback for the days its RSS feed has lost.
// Only scripts/nbk-excel-fill.mjs uses it; the scheduled runs keep failing on
// such a day, so a new gap is noticed instead of being papered over.
//
// The RSS answers 2023-07-28..2023-08-28 (except 2023-08-22) with
// <info>на выбранную дату информации нет.</info> and no items, and so does the
// HTML report; the Excel export of the same page has every day. Its sheet:
// row 1 is `Date | AUD_quant | AUD | AZN_quant | AZN | …`, then one row per
// calendar day, `DD.MM.YYYY` and quants as inline strings, rates as numbers,
// and no cells at all for a currency not quoted that day. Rates are KZT per
// quant units, the same numbers the RSS serves (a day both have must match
// exactly, or nothing is filled).

import { inflateRawSync } from 'node:zlib';
import { eachDay, fromDmy, toDmy, yearOf } from './dates.mjs';
import { foreignPerHome, isQuote, parseDecimal } from './normalize.mjs';
import { parse as parseRss } from './providers/nbk.mjs';

const RSS_URL = 'https://nationalbank.kz/rss/get_rates.cfm';
const EXCEL_URL = 'https://nationalbank.kz/en/exchangerates/ezhednevnye-oficialnye-rynochnye-kursy-valyut/excel';

/** The page's currency checkboxes (`rates[]`), October 2026: all 48 currencies. */
export const CURRENCY_IDS = [
  1, 48, 51, 38, 46, 42, 55, 45, 52, 3, 4, 5, 6, 58, 61, 49, 64, 53, 7, 67, 8, 9, 10, 47,
  54, 13, 70, 14, 73, 76, 39, 15, 16, 79, 17, 18, 44, 50, 41, 20, 21, 2, 43, 22, 23, 40, 25, 26,
];

export function excelUrl(from, to) {
  const ids = CURRENCY_IDS.map((id) => `rates%5B%5D=${id}`).join('&');
  return `${EXCEL_URL}?beginDate=${toDmy(from, '.')}&endDate=${toDmy(to, '.')}&search-exchanges=&${ids}`;
}

/** True only for the RSS answer "no information for the selected date": a dated feed with no items. */
export function isNoInformation(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  return (
    text.includes('<rates>') &&
    /<date>[^<]*<\/date>/.test(text) &&
    !text.includes('<item>') &&
    /<info>\s*на выбранную дату информации нет\.\s*<\/info>/.test(text)
  );
}

/** The entries of a zip archive (stored or deflated), read via its central directory. */
export function unzip(zip) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  const files = new Map();
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = zip.readUInt16LE(eocd + 10); i > 0; i--) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = zip.subarray(data, data + size);
    if (method === 0) files.set(name, bytes);
    else if (method === 8) files.set(name, inflateRawSync(bytes));
    else throw new Error(`zip: ${name} uses compression method ${method}`);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

/** Text of every cell of the first sheet: Map row number → Map column letters → string. */
function readSheet(xlsx) {
  const files = unzip(xlsx);
  const sheet = files.get('xl/worksheets/sheet1.xml')?.toString('utf8');
  if (!sheet) throw new Error('not an xlsx workbook');
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    ([, si]) => [...si.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join(''),
  );
  const rows = new Map();
  for (const [, col, row, attrs, inner = ''] of sheet.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const type = /t="([^"]*)"/.exec(attrs)?.[1];
    const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
    const text =
      type === 'inlineStr' ? [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join('') : type === 's' ? shared[Number(v)] : v;
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row).set(col, (text ?? '').trim());
  }
  return rows;
}

/**
 * Parses an Excel export into one publication per row, oldest first.
 * @returns {{date: string, rates: Record<string, number>}[]}
 */
export function parseExcel(xlsx) {
  const rows = readSheet(xlsx);
  const header = rows.get('1');
  const columnOf = new Map([...(header ?? [])].map(([col, name]) => [name, col]));
  const dateCol = columnOf.get('Date');
  const pairs = [...columnOf.keys()]
    .filter((name) => /^[A-Z]{3}$/.test(name) && columnOf.has(`${name}_quant`))
    .map((code) => ({ code, rate: columnOf.get(code), quant: columnOf.get(`${code}_quant`) }));
  if (!dateCol || pairs.length === 0) throw new Error('not an NBK Excel export (no Date / XXX_quant / XXX header)');

  const publications = [];
  for (const [n, cells] of rows) {
    if (n === '1') continue;
    const rates = {};
    for (const { code, rate, quant } of pairs) {
      if (!cells.get(rate) && !cells.get(quant)) continue; // not quoted that day
      const quote = parseDecimal(cells.get(rate));
      const units = parseDecimal(cells.get(quant));
      if (Number.isNaN(quote) || Number.isNaN(units)) throw new Error(`row ${n}: ${code} is not a number`);
      if (!isQuote(quote) || !isQuote(units)) continue;
      rates[code.toLowerCase()] = foreignPerHome(quote, units);
    }
    publications.push({ date: fromDmy(cells.get(dateCol)), rates });
  }
  return publications.sort((a, b) => (a.date < b.date ? -1 : 1));
}

const lastDayOfMonth = (iso) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** Throws unless every day both have is identical (codes and numbers); returns how many days were compared. */
function crossCheck(excel, rss) {
  let compared = 0;
  for (const [date, { rates }] of excel) {
    const fromRss = rss.get(date)?.rates;
    if (!fromRss) continue;
    const codes = Object.keys(rates).sort().join(',');
    const rssCodes = Object.keys(fromRss).sort().join(',');
    if (codes !== rssCodes) throw new Error(`nbk: the export differs from the RSS on ${date}: codes ${codes} ≠ ${rssCodes}`);
    for (const code of Object.keys(rates)) {
      if (!Object.is(rates[code], fromRss[code])) {
        throw new Error(`nbk: the export differs from the RSS on ${date}: ${code} ${rates[code]} ≠ ${fromRss[code]}`);
      }
    }
    compared++;
  }
  if (compared === 0) throw new Error('nbk: the export shares no day with the RSS answers, nothing to cross-check');
  return compared;
}

/**
 * NBK's fetchRange with the Excel export for the days the RSS has lost: one
 * RSS request per day (raw kept for every asked day, the empty answers too);
 * a day answered with exactly "no information" is taken from one export of
 * `excelFrom..excelTo` (default: the calendar months of the gap), after the
 * export matched the RSS on every day both have. Any other empty or odd
 * answer throws, as in fetchDaily.
 */
export async function fetchRangeWithExcel(from, to, ctx, { excelFrom, excelTo } = {}) {
  const byDate = new Map();
  const raw = [];
  const gaps = [];
  for (const asked of eachDay(from, to)) {
    const body = await ctx.http.get(`${RSS_URL}?fdate=${toDmy(asked, '.')}`);
    raw.push({ path: `raw/nbk/${yearOf(asked)}/${asked}.xml`, body });
    if (isNoInformation(body)) {
      gaps.push(asked);
      continue;
    }
    let publication;
    try {
      publication = parseRss(body);
    } catch (e) {
      throw new Error(`nbk: cannot parse the answer for ${asked}: ${e.message}`, { cause: e });
    }
    if (publication.date > asked) throw new Error(`nbk: asked for ${asked}, got a publication dated ${publication.date}`);
    if (Object.keys(publication.rates).length === 0) throw new Error(`nbk: the answer for ${asked} has no rates`);
    byDate.set(publication.date, publication);
  }

  if (gaps.length > 0) {
    const start = excelFrom ?? `${gaps[0].slice(0, 7)}-01`;
    const end = excelTo ?? lastDayOfMonth(gaps.at(-1));
    ctx.log(`${gaps.length} day(s) without RSS rates, ${gaps[0]}..${gaps.at(-1)}: Excel export ${start}..${end}`);
    const body = await ctx.http.get(excelUrl(start, end));
    raw.push({ path: `raw/nbk/${yearOf(start)}/excel-${start}_${end}.xlsx`, body });
    const excel = new Map(parseExcel(body).map((p) => [p.date, p]));
    const compared = crossCheck(excel, byDate);
    ctx.log(`the export matches the RSS on all ${compared} day(s) both have`);
    for (const day of gaps) {
      const publication = excel.get(day);
      if (!publication) throw new Error(`nbk: ${day} has no RSS rates and is not in the export ${start}..${end}`);
      byDate.set(day, publication);
    }
  }
  return { publications: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), raw };
}
