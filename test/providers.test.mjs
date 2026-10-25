// Parser tests on real responses saved on 2026-10-25 (test/fixtures/).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ecb from '../src/providers/ecb.mjs';
import * as cba from '../src/providers/cba.mjs';
import * as nbg from '../src/providers/nbg.mjs';
import * as nbk from '../src/providers/nbk.mjs';
import * as cbr from '../src/providers/cbr.mjs';
import { GRAMS_PER_TROY_OUNCE } from '../src/normalize.mjs';

const fixture = (path) => readFileSync(new URL(`fixtures/${path}`, import.meta.url));
const codesOk = (rates) => Object.keys(rates).every((c) => /^[a-z]{3}$/.test(c));

test('ecb: daily file (single-quoted attributes) — quotes are already foreign per 1 EUR', () => {
  const pubs = ecb.parse(fixture('ecb/eurofxref-daily.xml'));
  assert.equal(pubs.length, 1);
  const [{ date, rates }] = pubs;
  assert.equal(date, '2026-10-23');
  assert.equal(rates.usd, 1.1193);
  assert.equal(rates.jpy, 175.51);
  assert.equal(Object.keys(rates).length, 29);
  assert.ok(codesOk(rates));
});

test('ecb: 90-day file (double-quoted attributes), oldest first', () => {
  const pubs = ecb.parse(fixture('ecb/eurofxref-hist-90d.head.xml'));
  assert.deepEqual(
    pubs.map((p) => p.date),
    ['2026-10-21', '2026-10-22', '2026-10-23'],
  );
  assert.equal(pubs[0].rates.usd, 1.1234);
});

test('ecb: rejects a document that is not eurofxref', () => {
  assert.throws(() => ecb.parse('<html>maintenance</html>'), /not an ECB/);
});

test('cba: header units, inversion, per-gram metals, skipped blanks', () => {
  const pubs = cba.parse(fixture('cba/export-2026-10.csv'));
  assert.equal(pubs.length, 10); // working days 12.10–23.10
  assert.equal(pubs[0].date, '2026-10-12');
  const last = pubs.at(-1);
  assert.equal(last.date, '2026-10-23');
  assert.equal(last.rates.kzt, 10 / 7.9608); // "KZT 10" = 7.9608 AMD per 10 KZT
  assert.equal(last.rates.usd, 1 / 361.14);
  assert.equal(last.rates.irr, 100 / 0.019645); // "IRR 100"
  assert.equal(last.rates.xau, 1 / (47004 * GRAMS_PER_TROY_OUNCE)); // AMD per gram → troy ounces per AMD
  assert.equal(last.rates.xag, 1 / (648.3 * GRAMS_PER_TROY_OUNCE));
  assert.equal('ars' in last.rates, false); // empty cell = not quoted
  assert.ok(codesOk(last.rates));
});

test('cba: 2020 rows — "0" cells (LTL, LVL, SKK) and empty cells are not quoted', () => {
  const pubs = cba.parse(fixture('cba/export-2020-01.csv'));
  assert.deepEqual(
    pubs.map((p) => p.date),
    ['2020-01-08', '2020-01-09', '2020-01-10'],
  );
  const { rates } = pubs[0];
  for (const code of ['ltl', 'lvl', 'skk', 'nzd']) assert.equal(code in rates, false, code);
  assert.equal(rates.uzs, 10 / 0.5);
  assert.equal(rates.eur, 1 / 534.16);
});

test('cba: the SOAP code list', () => {
  const codes = cba.parseIsoCodes(fixture('cba/iso-codes-detailed.xml'));
  assert.equal(codes.length, 50);
  for (const code of ['KZT', 'GEL', 'XAU', 'LTL']) assert.ok(codes.includes(code), code);
});

test('cba: export URL uses plain currencies[] and DD/MM/YYYY dates', () => {
  const url = new URL(cba.exportUrl(['EUR', 'KZT'], '2020-01-01', '2026-10-25'));
  assert.deepEqual(url.searchParams.getAll('currencies[]'), ['EUR', 'KZT']);
  assert.equal(url.searchParams.get('date-from'), '01/01/2020');
  assert.equal(url.searchParams.get('date-to'), '25/10/2026');
});

test('cba: a CSV whose header changed shape fails loudly', () => {
  assert.throws(() => cba.parse('" ","Euro"\n"01.01.2020","1"\n'), /unexpected header/);
});

test('nbg: keyed by the answer date (Sunday 25.10 answers with Saturday 24.10), per-quantity quotes', () => {
  const { date, rates } = nbg.parse(fixture('nbg/2026-10-25.json'));
  assert.equal(date, '2026-10-24');
  assert.equal(rates.amd, 1000 / 7.188);
  assert.equal(rates.kzt, 100 / 0.5745);
  assert.equal(rates.rsd, 100 / 2.4748);
  assert.equal(rates.usd, 1 / 2.5971);
  assert.ok(codesOk(rates));
});

test('nbg: 2020 — quantity is read per answer (RSD per 10 then, per 100 now)', () => {
  const { date, rates } = nbg.parse(fixture('nbg/2020-01-01.json'));
  assert.equal(date, '2020-01-01');
  assert.equal(rates.rsd, 10 / 2.7334);
  assert.equal(rates.eur, 1 / 3.2143);
});

test('nbk: RSS item quotes are KZT per quant', () => {
  const { date, rates } = nbk.parse(fixture('nbk/2026-10-25.xml'));
  assert.equal(date, '2026-10-25');
  assert.equal(Object.keys(rates).length, 48);
  assert.equal(rates.amd, 10 / 12.56);
  assert.equal(rates.usd, 1 / 451.05);
  assert.equal(rates.irr, 10000 / 2.46);
  assert.ok(codesOk(rates));
});

test('nbk: 2020 answer has its own (smaller) currency list', () => {
  const { date, rates } = nbk.parse(fixture('nbk/2020-01-01.xml'));
  assert.equal(date, '2020-01-01');
  assert.equal(Object.keys(rates).length, 39);
  assert.equal('vnd' in rates, false);
});

test('cbr: windows-1251, comma decimals, keyed by ValCurs Date (Sunday → Saturday)', () => {
  const { date, rates } = cbr.parse(fixture('cbr/2026-10-25.xml'));
  assert.equal(date, '2026-10-24');
  assert.equal(Object.keys(rates).length, 54);
  assert.equal(rates.amd, 100 / 22.3011);
  assert.equal(rates.gel, 1 / 31.0084);
  assert.equal(rates.usd, 1 / 80.5381);
  assert.ok(codesOk(rates));
});

test('cbr: 05.01.2020 answers with the rates of 01.01.2020; no GEL then', () => {
  const { date, rates } = cbr.parse(fixture('cbr/2020-01-05.xml'));
  assert.equal(date, '2020-01-01');
  assert.equal(rates.kzt, 100 / 16.1665);
  assert.equal('gel' in rates, false);
});
