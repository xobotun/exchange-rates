#!/usr/bin/env node
// Updates the rates tree.
//
//   node scripts/update.mjs                       the last 10 days, every provider
//   node scripts/update.mjs --from 2019-12-24     backfill from a date up to today
//   node scripts/update.mjs --provider nbk,cba --from 2024-01-01 --to 2024-12-31
//   node scripts/update.mjs --days 1              yesterday and today (what the scheduled workflow runs)
//   node scripts/update.mjs --from 2024-01-01 --to 2024-12-31 --max-years 2
//                                                 a provider whose window, widened to join its
//                                                 published dates, spans more years fails unfetched
//   node scripts/update.mjs --out out             write somewhere else (default: the repo root)
//
// Providers run in parallel (different banks), requests to one bank run one
// after another, at most two per second. A provider that fails writes
// nothing for the failed year chunk and makes the exit code 1; the others
// are still written. See README.md.

import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, providerById } from '../src/providers/index.mjs';
import { createHttp } from '../src/http.mjs';
import { addDays, assertIsoDate, todayUtc } from '../src/dates.mjs';
import { updateProvider, writeProvidersList } from '../src/update.mjs';

const DEFAULT_DAYS = 10;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    'usage: node scripts/update.mjs [--provider id[,id…]] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days N] [--max-years N] [--out DIR]\n' +
      `providers: ${PROVIDERS.map((p) => p.id).join(', ')}`,
  );
  process.exit(2);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      provider: { type: 'string', multiple: true },
      from: { type: 'string' },
      to: { type: 'string' },
      days: { type: 'string', default: String(DEFAULT_DAYS) },
      'max-years': { type: 'string' },
      out: { type: 'string', default: REPO_ROOT },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  }));
} catch (e) {
  usage(e.message);
}
if (args.help) usage();

const today = todayUtc();
let providers;
let from;
let to;
let maxYears;
try {
  const ids = (args.provider ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  providers = ids.length > 0 ? ids.map(providerById) : PROVIDERS;
  const days = Number(args.days);
  if (!Number.isInteger(days) || days < 0) throw new Error('--days must be a whole number');
  to = args.to ? assertIsoDate(args.to, '--to') : today;
  from = args.from ? assertIsoDate(args.from, '--from') : addDays(to, -days);
  if (from > to) throw new Error('--from is after --to');
  if (args['max-years'] !== undefined) {
    maxYears = Number(args['max-years']);
    if (!Number.isInteger(maxYears) || maxYears < 1) throw new Error('--max-years must be a whole number ≥ 1');
  }
} catch (e) {
  usage(e.message);
}

const outDir = resolve(args.out);
console.error(`rates update ${from}..${to} (today ${today}, UTC) → ${outDir}`);

const results = await Promise.all(
  providers.map(async (provider) => {
    const log = (message) => console.error(`[${provider.id}] ${message}`);
    const http = createHttp({ log });
    try {
      const result = await updateProvider({ provider, outDir, from, to, today, http, maxYears, log });
      log(`${result.ok ? 'ok' : 'FAILED'}: ${result.changed} file(s) changed, ${http.requestCount} request(s), published ${result.span ? `${result.span.first}..${result.span.last}` : 'nothing'}`);
      return result;
    } catch (error) {
      log(`FAILED: ${error.stack ?? error}`);
      return { id: provider.id, ok: false, error };
    }
  }),
);

await writeProvidersList(outDir);

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`failed: ${failed.map((r) => `${r.id} (${r.error?.message})`).join('; ')}`);
  process.exit(1);
}
