#!/usr/bin/env node
// Fills the NBK days the RSS feed has lost ("на выбранную дату информации
// нет.") from NBK's Excel export. The workflows write such a day as a repeat
// of the previous publication and warn about it; run this by hand afterwards
// for a range around the warned days. See README "Maintenance notes" and
// src/nbk-excel.mjs.
//
//   node scripts/nbk-excel-fill.mjs --from 2022-12-01 --to 2022-12-31
//   node scripts/nbk-excel-fill.mjs --from 2023-07-23 --to 2023-08-31 --out out
//
// One export request per calendar year of the range, nothing from the RSS.
// The range must lie inside what the tree already holds for nbk, and include
// at least one day the tree has: the export must match the stored rates
// exactly on every day both have, or nothing is written.

import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nbk from '../src/providers/nbk.mjs';
import { createHttp } from '../src/http.mjs';
import { assertIsoDate, todayUtc } from '../src/dates.mjs';
import { excelFetchRange } from '../src/nbk-excel.mjs';
import { readSpan, readStore } from '../src/tree.mjs';
import { updateProvider } from '../src/update.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error('usage: node scripts/nbk-excel-fill.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--out DIR]');
  process.exit(2);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
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
try {
  if (!args.from || !args.to) throw new Error('--from and --to are required');
  [from, to] = [assertIsoDate(args.from, '--from'), assertIsoDate(args.to, '--to')];
  if (from > to) throw new Error('--from is after --to');
} catch (e) {
  usage(e.message);
}

const outDir = resolve(args.out);
const span = await readSpan(outDir, nbk);
if (!span || from < span.first || to > span.last) {
  usage(`the tree holds nbk ${span ? `${span.first}..${span.last}` : 'nowhere'}; fill only inside it (backfill first)`);
}

const today = todayUtc();
const log = (message) => console.error(`[nbk] ${message}`);
const http = createHttp({ log });
const provider = { ...nbk, fetchRange: excelFetchRange(await readStore(outDir, nbk)) };
console.error(`nbk: filling ${from}..${to} from the Excel export → ${outDir}`);

const result = await updateProvider({ provider, outDir, from, to, today, http, log });
log(`${result.ok ? 'ok' : 'FAILED'}: ${result.changed} file(s) changed, ${http.requestCount} request(s)`);
if (!result.ok) {
  console.error(`failed: ${result.error?.message}`);
  process.exit(1);
}
