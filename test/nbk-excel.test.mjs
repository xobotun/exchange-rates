// The NBK Excel export (scripts/nbk-excel-fill.mjs) on real answers saved on
// 2026-10-26: the export for 23.07.2023–31.08.2023 with every currency, and
// the RSS answer for 27.07.2023 (the feed has nothing for
// 2023-07-28..2023-08-28 except 08-22).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nbk, { parse as parseRss } from '../src/providers/nbk.mjs';
import { excelFetchRange, excelUrl, parseExcel } from '../src/nbk-excel.mjs';
import { readStore } from '../src/tree.mjs';
import { updateProvider } from '../src/update.mjs';

const fixture = (path) => readFileSync(new URL(`fixtures/${path}`, import.meta.url));
const XLSX = fixture('nbk/excel-2023-07-23_2023-08-31.xlsx');
const RSS_0727 = fixture('nbk/2023-07-27.xml');

/** An http stub answering by URL substring (first match wins); records every request. */
function stubHttp(routes) {
  const requests = [];
  return {
    requests,
    async get(url) {
      requests.push(url);
      for (const [needle, body] of routes) if (url.includes(needle)) return body;
      throw new Error(`unexpected request ${url}`);
    },
  };
}

const ctx = (http) => ({ http, cache: new Map(), today: '2026-10-26', log: () => {}, missing: [] });

test('nbk excel: one publication per row, KZT per quant inverted like the RSS', () => {
  const pubs = parseExcel(XLSX);
  assert.equal(pubs.length, 40); // 23.07..31.08
  assert.equal(pubs[0].date, '2023-07-23');
  assert.equal(pubs.at(-1).date, '2023-08-31');
  const on = (date) => pubs.find((p) => p.date === date).rates;
  assert.equal(on('2023-07-28').eur, 1 / 495.37);
  assert.equal(on('2023-08-22').eur, 1 / 493.05);
  assert.equal(on('2023-08-29').eur, 1 / 501.45);
  assert.equal(on('2023-07-27').amd, 10 / 11.49);
  assert.equal(on('2023-07-27').irr, 1000 / 10.6);
  assert.equal('vnd' in on('2023-07-27'), false); // not quoted in 2023: no cell at all
});

test('nbk excel: 27.07.2023 is exactly the RSS answer for that day (codes and numbers)', () => {
  const rss = parseRss(RSS_0727);
  const excel = parseExcel(XLSX).find((p) => p.date === '2023-07-27');
  assert.equal(Object.keys(rss.rates).length, 39);
  assert.deepEqual(excel.rates, rss.rates);
});

test('nbk excel: the URL asks for every currency id and DD.MM.YYYY dates', () => {
  const url = new URL(excelUrl('2023-07-23', '2023-08-31'));
  assert.equal(url.searchParams.get('beginDate'), '23.07.2023');
  assert.equal(url.searchParams.get('endDate'), '31.08.2023');
  const ids = url.searchParams.getAll('rates[]');
  assert.equal(ids.length, 48);
  assert.ok(ids.includes('6')); // EUR
});

test('excelFetchRange: one export for the range; the days the tree lacks come from it, stored days stay', async () => {
  const http = stubHttp([['/excel?', XLSX]]);
  const stored = new Map([['2023-07-27', parseRss(RSS_0727).rates]]);
  const { publications, raw } = await excelFetchRange(stored)('2023-07-27', '2023-07-29', ctx(http));
  assert.deepEqual(publications.map((p) => p.date), ['2023-07-27', '2023-07-28', '2023-07-29']);
  assert.deepEqual(publications[0].rates, stored.get('2023-07-27'));
  assert.equal(publications[1].rates.eur, 1 / 495.37);
  assert.equal(publications[2].rates.eur, 1 / 489);
  assert.deepEqual(raw.map((r) => r.path), ['raw/nbk/2023/excel-2023-07-27_2023-07-29.xlsx']);
  assert.equal(http.requests.length, 1);
  assert.equal(new URL(http.requests[0]).searchParams.get('beginDate'), '27.07.2023');
});

test('excelFetchRange: a stored day that differs from the export fails', async () => {
  const http = stubHttp([['/excel?', XLSX]]);
  const stored = new Map([['2023-07-27', { ...parseRss(RSS_0727).rates, eur: 1 / 492.02 }]]);
  await assert.rejects(excelFetchRange(stored)('2023-07-27', '2023-07-28', ctx(http)), /2023-07-27.*eur/);
});

test('excelFetchRange: without a stored day in the range to compare against, nothing is filled', async () => {
  const http = stubHttp([['/excel?', XLSX]]);
  const stored = new Map([['2023-07-27', parseRss(RSS_0727).rates]]);
  await assert.rejects(excelFetchRange(stored)('2023-07-28', '2023-07-29', ctx(http)), /nothing to cross-check/);
});

test('excelFetchRange: a day neither stored nor in the export fails', async () => {
  const http = stubHttp([['/excel?', XLSX]]);
  const stored = new Map([['2023-08-31', parseExcel(XLSX).at(-1).rates]]);
  await assert.rejects(excelFetchRange(stored)('2023-08-31', '2023-09-01', ctx(http)), /2023-09-01/);
});

test('excelFetchRange with updateProvider: carried-forward days get their own publication, a rerun changes nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rates-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rss = parseRss(RSS_0727);
  const feed = { ...nbk, fetchRange: async () => ({ publications: [rss], raw: [] }) }; // 28 and 29 lost
  const run = (provider) =>
    updateProvider({ provider, outDir: dir, from: '2023-07-27', to: '2023-07-29', today: '2026-10-26', http: stubHttp([['/excel?', XLSX]]) });
  await run(feed);
  const day = (date) => JSON.parse(readFileSync(join(dir, `v1/nbk/${date}/currencies/kzt.json`), 'utf8'));
  assert.equal(day('2023-07-28').date, '2023-07-27');

  const patched = await run({ ...nbk, fetchRange: excelFetchRange(await readStore(dir, nbk)) });
  assert.equal(patched.ok, true);
  assert.deepEqual(day('2023-07-27'), { date: '2023-07-27', kzt: Object.fromEntries(Object.entries(rss.rates).sort()) });
  assert.equal(day('2023-07-28').date, '2023-07-28');
  assert.equal(day('2023-07-28').kzt.eur, 1 / 495.37);
  assert.equal(day('2023-07-29').kzt.eur, 1 / 489);

  const again = await run({ ...nbk, fetchRange: excelFetchRange(await readStore(dir, nbk)) });
  assert.equal(again.changed, 0);
});
