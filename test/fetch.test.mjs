// Provider fetch logic and the HTTP client, with stubbed network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ecb from '../src/providers/ecb.mjs';
import cba from '../src/providers/cba.mjs';
import nbg from '../src/providers/nbg.mjs';
import nbk from '../src/providers/nbk.mjs';
import { createHttp } from '../src/http.mjs';

const fixture = (path) => readFileSync(new URL(`fixtures/${path}`, import.meta.url));

/** An http stub answering by URL substring; records every request. */
function stubHttp(routes) {
  const requests = [];
  const answer = (method) => async (url, init) => {
    requests.push({ method, url, init });
    for (const [needle, body] of routes) if (url.includes(needle)) return typeof body === 'function' ? body(url) : body;
    throw new Error(`unexpected request ${url}`);
  };
  return { requests, get: answer('GET'), post: answer('POST') };
}

const ctx = (http, today = '2026-10-25') => ({ http, cache: new Map(), today, log: () => {} });

test('daily banks: one request per calendar day, answers keyed by the bank date, raw kept per asked date', async () => {
  const http = stubHttp([['nbg.gov.ge', fixture('nbg/2026-10-25.json')]]); // dated 2026-10-24
  const { publications, raw } = await nbg.fetchRange('2026-10-25', '2026-10-26', ctx(http));
  assert.deepEqual(
    http.requests.map((r) => new URL(r.url).searchParams.get('date')),
    ['2026-10-25', '2026-10-26'],
  );
  assert.deepEqual(
    publications.map((p) => p.date),
    ['2026-10-24'],
  );
  assert.deepEqual(
    raw.map((r) => r.path),
    ['raw/nbg/2026/2026-10-25.json', 'raw/nbg/2026/2026-10-26.json'],
  );
});

test('daily banks: NBK asks with DD.MM.YYYY; an answer dated after the asked day is refused', async () => {
  const http = stubHttp([['nationalbank.kz', fixture('nbk/2026-10-25.xml')]]);
  const { publications } = await nbk.fetchRange('2026-10-25', '2026-10-25', ctx(http));
  assert.equal(new URL(http.requests[0].url).searchParams.get('fdate'), '25.10.2026');
  assert.equal(publications[0].date, '2026-10-25');
  await assert.rejects(nbk.fetchRange('2026-10-24', '2026-10-24', ctx(http)), /got a publication dated 2026-10-25/);
});

test('daily banks: an unparsable answer fails the whole range', async () => {
  const http = stubHttp([['nbg.gov.ge', Buffer.from('<html>busy</html>')]]);
  await assert.rejects(nbg.fetchRange('2026-10-25', '2026-10-25', ctx(http)), /cannot parse the answer for 2026-10-25/);
});

test('ecb: the 90-day file when it reaches back far enough, else the full history once per run', async () => {
  const http = stubHttp([
    ['eurofxref-hist-90d.xml', fixture('ecb/eurofxref-hist-90d.head.xml')], // 21.10–23.10
    ['eurofxref-hist.xml', fixture('ecb/eurofxref-daily.xml')],
  ]);
  const c = ctx(http);
  // Window start minus the 21-day look-back is inside the 90-day file: no history download.
  const recent = await ecb.fetchRange('2026-11-12', '2026-11-13', c);
  assert.deepEqual(
    http.requests.map((r) => r.url.split('/').at(-1)),
    ['eurofxref-hist-90d.xml'],
  );
  assert.deepEqual(
    recent.publications.map((p) => p.date),
    ['2026-10-22', '2026-10-23'],
  );
  assert.equal(recent.raw[0].path, 'raw/ecb/2026/eurofxref-hist-90d.xml');
  // Older window: needs the full history, downloaded once even for two chunks.
  await ecb.fetchRange('2025-01-01', '2025-12-31', c);
  const old = await ecb.fetchRange('2024-01-01', '2024-12-31', c);
  assert.deepEqual(
    http.requests.map((r) => r.url.split('/').at(-1)),
    ['eurofxref-hist-90d.xml', 'eurofxref-hist.xml'],
  );
  assert.equal(old.raw[0].path, 'raw/ecb/2026/eurofxref-hist.xml');
});

test('cba: the code list comes from SOAP once; the export asks with a 21-day look-back', async () => {
  const http = stubHttp([
    ['api.cba.am', fixture('cba/iso-codes-detailed.xml')],
    ['exchange-rates-archive/export', fixture('cba/export-2026-10.csv')],
  ]);
  const c = ctx(http);
  const { publications, raw } = await cba.fetchRange('2026-10-20', '2026-10-25', c);
  await cba.fetchRange('2026-10-20', '2026-10-25', c);
  assert.deepEqual(
    http.requests.map((r) => r.method),
    ['POST', 'GET', 'GET'],
  );
  assert.match(http.requests[0].init.headers.SOAPAction, /ISOCodesDetailed/);
  const url = new URL(http.requests[1].url);
  assert.equal(url.searchParams.getAll('currencies[]').length, 50);
  assert.equal(url.searchParams.get('date-from'), '29/09/2026');
  assert.equal(url.searchParams.get('date-to'), '25/10/2026');
  assert.equal(publications.length, 10);
  assert.equal(raw[0].path, 'raw/cba/2026/export.csv');
});

// ---- HTTP client -----------------------------------------------------------

function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const response = (status, body = 'ok') => new Response(body, { status });

test('http: retries 5xx and network errors with exponential backoff, then succeeds', async () => {
  const clock = fakeClock();
  const answers = [() => response(503), () => Promise.reject(new TypeError('fetch failed')), () => response(200, 'data')];
  const calls = [];
  const http = createHttp({
    ...clock,
    backoffMs: 1000,
    minIntervalMs: 0,
    fetchImpl: async (url, init) => {
      calls.push(init.headers['User-Agent']);
      return answers.shift()();
    },
  });
  const body = await http.get('https://bank.example/x');
  assert.equal(body.toString(), 'data');
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps, [1000, 2000]);
  assert.match(calls[0], /^exchange-rates\//);
});

test('http: a 4xx other than 429 fails at once', async () => {
  let calls = 0;
  const http = createHttp({ ...fakeClock(), fetchImpl: async () => (calls++, response(404)) });
  await assert.rejects(http.get('https://bank.example/missing'), /HTTP 404/);
  assert.equal(calls, 1);
});

test('http: gives up after the last retry with the last error', async () => {
  const http = createHttp({ ...fakeClock(), retries: 2, fetchImpl: async () => response(500) });
  await assert.rejects(http.get('https://bank.example/x'), /HTTP 500/);
  assert.equal(http.requestCount, 3);
});

test('http: at most one request start per minIntervalMs (2 per second by default)', async () => {
  const clock = fakeClock();
  const http = createHttp({ ...clock, fetchImpl: async () => response(200) });
  await http.get('https://bank.example/1');
  await http.get('https://bank.example/2');
  await http.get('https://bank.example/3');
  assert.deepEqual(clock.sleeps, [500, 500]);
});
