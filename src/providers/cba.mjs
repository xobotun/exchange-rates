import { HISTORY_START } from '../history.mjs';
import { addDays, fromDmy, toDmy, yearOf } from '../dates.mjs';
import { GRAMS_PER_TROY_OUNCE, foreignPerHome, isQuote, parseDecimal } from '../normalize.mjs';

// Central Bank of Armenia, exchange-rate archive CSV export.
// https://www.cba.am/en/exchange-rates-archive/
//
// Quirks:
// - Working days only (Armenian calendar; the first 2020 row is 08.01.2020).
// - One request returns a date range, but a long range with every currency
//   times out (2020→2026 with 50 codes: empty reply after ~65 s). One
//   calendar year takes ~23 s, and the updater already works in year chunks.
// - The header carries the unit: "KZT 10" = AMD per 10 KZT. Inverted and
//   divided down: 10 / quote KZT per 1 AMD.
// - A currency not quoted on a date is "" or "0" (the euro-replaced LTL, LVL,
//   SKK still sit in the 2020 file as "0"); both are skipped.
// - Gold (XAU) and silver (XAG) are AMD per GRAM (2020-01-08: XAU 24183.52 /
//   USD 479.76 = $50.4/g ≈ $1568/oz; XAG 279.88 / 479.76 = $0.58/g ≈ $18/oz,
//   both matching the market). ISO 4217 XAU/XAG are one troy ounce, so they
//   are converted to ounces before inverting.
// - The code list comes from the SOAP service (ISOCodesDetailed): the same
//   50 codes as the archive form, historical ones included.
// - No CORS on the export, so browsers cannot read it directly.

const EXPORT_URL = 'https://www.cba.am/en/exchange-rates-archive/export';
const SOAP_URL = 'https://api.cba.am/exchangerates.asmx';
const LOOKBACK_DAYS = 21; // covers the Armenian New Year / Christmas break (31 Dec – 7 Jan)
const METAL_GRAMS = { XAU: GRAMS_PER_TROY_OUNCE, XAG: GRAMS_PER_TROY_OUNCE };

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/**
 * Parses the archive export.
 * @returns {{date: string, rates: Record<string, number>}[]} oldest first
 */
export function parse(csv) {
  const text = (Buffer.isBuffer(csv) ? csv.toString('utf8') : csv).replace(/^﻿/, '');
  const [header, ...rows] = parseCsv(text);
  if (!header || header.length < 2) throw new Error('empty CSV');
  const columns = header.slice(1).map((cell) => {
    const m = /^([A-Z]{3}) (\d+)$/.exec(cell.trim());
    if (!m) throw new Error(`unexpected header cell ${JSON.stringify(cell)}`);
    return { code: m[1], units: Number(m[2]) };
  });
  const publications = [];
  for (const row of rows) {
    if (row.length !== header.length) throw new Error(`row has ${row.length} cells, header ${header.length}`);
    const rates = {};
    columns.forEach(({ code, units }, i) => {
      const quote = parseDecimal(row[i + 1]);
      if (!isQuote(quote)) return;
      rates[code.toLowerCase()] = foreignPerHome(quote * (METAL_GRAMS[code] ?? 1), units);
    });
    if (Object.keys(rates).length > 0) publications.push({ date: fromDmy(row[0]), rates });
  }
  return publications.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Parses the SOAP ISOCodesDetailed answer into ['AED', 'ARS', …]. */
export function parseIsoCodes(xml) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml;
  const codes = [...text.matchAll(/<ISO>([A-Z]{3})<\/ISO>/g)].map((m) => m[1]);
  if (codes.length === 0) throw new Error('no <ISO> codes in the SOAP answer');
  return [...new Set(codes)].sort();
}

async function isoCodes(ctx) {
  if (!ctx.cache.has('cba:codes')) {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soap:Body><ISOCodesDetailed xmlns="http://www.cba.am/" /></soap:Body></soap:Envelope>';
    const pending = ctx.http
      .post(SOAP_URL, {
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://www.cba.am/ISOCodesDetailed"' },
        body,
      })
      .then(parseIsoCodes);
    pending.catch(() => ctx.cache.delete('cba:codes'));
    ctx.cache.set('cba:codes', pending);
  }
  return ctx.cache.get('cba:codes');
}

export function exportUrl(codes, from, to) {
  const params = new URLSearchParams();
  for (const code of codes) params.append('currencies[]', code);
  params.set('date-from', toDmy(from, '/'));
  params.set('date-to', toDmy(to, '/'));
  return `${EXPORT_URL}?${params}`;
}

async function fetchRange(from, to, ctx) {
  const codes = await isoCodes(ctx);
  const body = await ctx.http.get(exportUrl(codes, addDays(from, -LOOKBACK_DAYS), to), { timeoutMs: 120_000 });
  return {
    publications: parse(body),
    // Stable name per year: a later fetch for the same year overwrites it; git history keeps the rest.
    raw: [{ path: `raw/cba/${yearOf(to)}/export.csv`, body }],
  };
}

export default {
  id: 'cba',
  name: 'Central Bank of Armenia',
  home: 'amd',
  source: 'https://www.cba.am/en/exchange-rates-archive/',
  firstDate: HISTORY_START,
  fetchRange,
};
