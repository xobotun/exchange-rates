// NBK's Excel export, to fill the days its RSS feed has lost. Only
// scripts/nbk-excel-fill.mjs uses it, by hand: the scheduled runs write such a
// day as a repeat of the previous publication and warn about it.
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
import { dateRuns, eachDay, fromDmy, toDmy, yearOf } from './dates.mjs';
import { foreignPerHome, isQuote, parseDecimal } from './normalize.mjs';

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

/** Throws unless every day both have is identical (codes and numbers); returns how many days were compared. */
function crossCheck(excel, stored) {
  let compared = 0;
  for (const [date, rates] of excel) {
    const have = stored.get(date);
    if (!have) continue;
    const codes = Object.keys(rates).sort().join(',');
    const storedCodes = Object.keys(have).sort().join(',');
    if (codes !== storedCodes) throw new Error(`nbk: the export differs from the stored rates on ${date}: codes ${codes} ≠ ${storedCodes}`);
    for (const code of Object.keys(rates)) {
      if (!Object.is(rates[code], have[code])) {
        throw new Error(`nbk: the export differs from the stored rates on ${date}: ${code} ${rates[code]} ≠ ${have[code]}`);
      }
    }
    compared++;
  }
  if (compared === 0) throw new Error('nbk: the export shares no day with the stored rates, nothing to cross-check');
  return compared;
}

/**
 * NBK's fetchRange for filling, from one Excel export per range, the days the
 * tree has no publication for. `stored` is the tree's date → rates (readStore):
 * every day both have must match the export exactly, at least one must, and
 * the export must have every day of the range the tree lacks. Returns the
 * export's rows of the range; the stored days come back unchanged.
 */
export function excelFetchRange(stored) {
  return async (from, to, ctx) => {
    const body = await ctx.http.get(excelUrl(from, to));
    const publications = parseExcel(body).filter((p) => p.date >= from && p.date <= to);
    const excel = new Map(publications.map((p) => [p.date, p.rates]));
    const compared = crossCheck(excel, stored);
    const lacking = [...eachDay(from, to)].filter((day) => !stored.has(day));
    const absent = lacking.filter((day) => !excel.has(day));
    if (absent.length > 0) throw new Error(`nbk: no rates stored for ${dateRuns(absent).join(', ')}, and the export has none either`);
    ctx.log(`the export matches the stored rates on all ${compared} day(s) both have; filled from it: ${dateRuns(lacking).join(', ') || 'nothing'}`);
    return { publications, raw: [{ path: `raw/nbk/${yearOf(from)}/excel-${from}_${to}.xlsx`, body }] };
  };
}
