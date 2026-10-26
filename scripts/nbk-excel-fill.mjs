#!/usr/bin/env node
// Updates NBK like scripts/update.mjs, but takes the days the RSS feed has
// lost ("на выбранную дату информации нет.") from NBK's Excel export. Run by
// hand for a range the backfill workflow failed on; the workflows keep
// failing on such a day. See README "Maintenance notes" and src/nbk-excel.mjs.
//
//   node scripts/nbk-excel-fill.mjs --year 2023
//   node scripts/nbk-excel-fill.mjs --year 2023 --excel-from 2023-07-23 --excel-to 2023-08-31
//   node scripts/nbk-excel-fill.mjs --from 2023-07-01 --to 2023-08-31 --out out
//
// The export (default: the calendar months of the gap) must match the RSS
// exactly on every day both have, or nothing is written.

import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nbk from '../src/providers/nbk.mjs';
import { createHttp } from '../src/http.mjs';
import { assertIsoDate, todayUtc } from '../src/dates.mjs';
import { fetchRangeWithExcel } from '../src/nbk-excel.mjs';
import { updateProvider, writeProvidersList } from '../src/update.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    'usage: node scripts/nbk-excel-fill.mjs (--year YYYY | --from YYYY-MM-DD --to YYYY-MM-DD) [--excel-from YYYY-MM-DD --excel-to YYYY-MM-DD] [--out DIR]',
  );
  process.exit(2);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      year: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'excel-from': { type: 'string' },
      'excel-to': { type: 'string' },
      out: { type: 'string', default: REPO_ROOT },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  }));
} catch (e) {
  usage(e.message);
}
if (args.help) usage();

let from;
let to;
let excelFrom;
let excelTo;
try {
  if (args.year !== undefined) {
    if (!/^\d{4}$/.test(args.year) || args.from || args.to) throw new Error('--year YYYY, or --from and --to');
    [from, to] = [`${args.year}-01-01`, `${args.year}-12-31`];
  } else {
    if (!args.from || !args.to) throw new Error('--year YYYY, or --from and --to');
    [from, to] = [assertIsoDate(args.from, '--from'), assertIsoDate(args.to, '--to')];
  }
  if (from > to) throw new Error('--from is after --to');
  if (Boolean(args['excel-from']) !== Boolean(args['excel-to'])) throw new Error('--excel-from and --excel-to go together');
  if (args['excel-from']) {
    excelFrom = assertIsoDate(args['excel-from'], '--excel-from');
    excelTo = assertIsoDate(args['excel-to'], '--excel-to');
    if (excelFrom > excelTo) throw new Error('--excel-from is after --excel-to');
  }
} catch (e) {
  usage(e.message);
}

const today = todayUtc();
const outDir = resolve(args.out);
const log = (message) => console.error(`[nbk] ${message}`);
const http = createHttp({ log });
const provider = { ...nbk, fetchRange: (f, t, ctx) => fetchRangeWithExcel(f, t, ctx, { excelFrom, excelTo }) };
console.error(`nbk update with the Excel export for the RSS gaps, ${from}..${to} (today ${today}, UTC) → ${outDir}`);

const result = await updateProvider({ provider, outDir, from, to, today, http, maxYears: 2, log });
await writeProvidersList(outDir);
log(`${result.ok ? 'ok' : 'FAILED'}: ${result.changed} file(s) changed, ${http.requestCount} request(s), published ${result.span ? `${result.span.first}..${result.span.last}` : 'nothing'}`);
if (!result.ok) {
  console.error(`failed: ${result.error?.message}`);
  process.exit(1);
}
