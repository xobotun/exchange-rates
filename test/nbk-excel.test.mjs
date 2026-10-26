// The NBK Excel export (scripts/nbk-excel-fill.mjs) on real answers saved on
// 2026-10-26: the export for 23.07.2023–31.08.2023 with every currency, the
// RSS answer for 27.07.2023, and the RSS "no information" answer for
// 28.07.2023 (the feed has nothing for 2023-07-28..2023-08-28 except 08-22).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseRss } from '../src/providers/nbk.mjs';
import { excelUrl, fetchRangeWithExcel, isNoInformation, parseExcel } from '../src/nbk-excel.mjs';

const fixture = (path) => readFileSync(new URL(`fixtures/${path}`, import.meta.url));
const XLSX = fixture('nbk/excel-2023-07-23_2023-08-31.xlsx');
const RSS_0727 = fixture('nbk/2023-07-27.xml');
const NO_INFO = fixture('nbk/2023-07-28-no-information.xml');

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

const ctx = (http) => ({ http, cache: new Map(), today: '2026-10-26', log: () => {} });

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

test('nbk rss: only the exact "no information" answer counts as a gap', () => {
  assert.equal(isNoInformation(NO_INFO), true);
  assert.equal(isNoInformation(RSS_0727), false);
  const bare = NO_INFO.toString('utf8').replace(/<info>[^<]*<\/info>/, '');
  assert.equal(isNoInformation(Buffer.from(bare)), false);
});

test('fetchRangeWithExcel: RSS days stay, "no information" days come from the export, all raw kept', async () => {
  const http = stubHttp([
    ['fdate=27.07.2023', RSS_0727],
    ['get_rates.cfm', NO_INFO],
    ['/excel?', XLSX],
  ]);
  const { publications, raw } = await fetchRangeWithExcel('2023-07-27', '2023-07-29', ctx(http), {
    excelFrom: '2023-07-23',
    excelTo: '2023-08-31',
  });
  assert.deepEqual(
    publications.map((p) => p.date),
    ['2023-07-27', '2023-07-28', '2023-07-29'],
  );
  assert.deepEqual(publications[0].rates, parseRss(RSS_0727).rates);
  assert.equal(publications[1].rates.eur, 1 / 495.37);
  assert.equal(publications[2].rates.eur, 1 / 489);
  assert.deepEqual(
    raw.map((r) => r.path),
    [
      'raw/nbk/2023/2023-07-27.xml',
      'raw/nbk/2023/2023-07-28.xml',
      'raw/nbk/2023/2023-07-29.xml',
      'raw/nbk/2023/excel-2023-07-23_2023-08-31.xlsx',
    ],
  );
  assert.equal(http.requests.filter((u) => u.includes('/excel?')).length, 1);
});

test('fetchRangeWithExcel: no gap, no export request', async () => {
  const http = stubHttp([['fdate=27.07.2023', RSS_0727]]);
  const { publications, raw } = await fetchRangeWithExcel('2023-07-27', '2023-07-27', ctx(http));
  assert.deepEqual(publications.map((p) => p.date), ['2023-07-27']);
  assert.equal(raw.length, 1);
});

test('fetchRangeWithExcel: an export that differs from the RSS on a shared day fails', async () => {
  const changed = Buffer.from(RSS_0727.toString('utf8').replace('<description>492.01</description>', '<description>492.02</description>'));
  const http = stubHttp([
    ['fdate=27.07.2023', changed],
    ['get_rates.cfm', NO_INFO],
    ['/excel?', XLSX],
  ]);
  await assert.rejects(
    fetchRangeWithExcel('2023-07-27', '2023-07-28', ctx(http), { excelFrom: '2023-07-23', excelTo: '2023-08-31' }),
    /2023-07-27.*eur/,
  );
});

test('fetchRangeWithExcel: without an RSS day inside the export to compare against, nothing is filled', async () => {
  const http = stubHttp([
    ['get_rates.cfm', NO_INFO],
    ['/excel?', XLSX],
  ]);
  await assert.rejects(
    fetchRangeWithExcel('2023-07-28', '2023-07-29', ctx(http), { excelFrom: '2023-07-23', excelTo: '2023-08-31' }),
    /nothing to cross-check/,
  );
});

test('fetchRangeWithExcel: a gap day the export does not have fails', async () => {
  const http = stubHttp([
    ['fdate=27.07.2023', RSS_0727],
    ['get_rates.cfm', NO_INFO],
    ['/excel?', XLSX],
  ]);
  await assert.rejects(
    fetchRangeWithExcel('2023-07-27', '2023-09-01', ctx(http), { excelFrom: '2023-07-23', excelTo: '2023-08-31' }),
    /2023-09-01.*not in the export/,
  );
});

test('fetchRangeWithExcel: any other empty RSS answer still fails', async () => {
  const bare = Buffer.from(NO_INFO.toString('utf8').replace(/<info>[^<]*<\/info>/, ''));
  const http = stubHttp([['get_rates.cfm', bare]]);
  await assert.rejects(fetchRangeWithExcel('2023-07-28', '2023-07-28', ctx(http)), /2023-07-28.*no rates/);
});
