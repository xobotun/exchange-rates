// The v1 file tree (see README "Layout"): paths, file bodies, and reading the
// publications already published. The year files are the store: every
// publication between meta.first_date and meta.last_date is in exactly one
// of them, and every other file is derived from them.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isIsoDate } from './dates.mjs';
import { readJson, toJson } from './fsutil.mjs';

export const paths = {
  providers: () => 'v1/providers.json',
  meta: (p) => `v1/${p.id}/meta.json`,
  day: (p, date) => `v1/${p.id}/${date}/currencies/${p.home}.json`,
  latest: (p) => `v1/${p.id}/latest/currencies/${p.home}.json`,
  yearsDir: (p) => `v1/${p.id}/years`,
  year: (p, year) => `v1/${p.id}/years/${year}/currencies/${p.home}.json`,
};

/** Copy with codes in alphabetical order, so file bytes are stable. */
export function sortedRates(rates) {
  return Object.fromEntries(Object.keys(rates).sort().map((code) => [code, rates[code]]));
}

export function sameRates(a, b) {
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
}

/** `{"date": <publication date>, "<home>": {...}}` — also the `latest` body. */
export function dayFileBody(p, publicationDate, rates) {
  return toJson({ date: publicationDate, [p.home]: sortedRates(rates) });
}

/** `{"year": "2025", "<home>": {"2025-01-02": {...}, ...}}`, publication days only, oldest first. */
export function yearFileBody(p, year, publications) {
  const days = [...publications].sort((a, b) => (a.date < b.date ? -1 : 1));
  return toJson({ year, [p.home]: Object.fromEntries(days.map((pub) => [pub.date, sortedRates(pub.rates)])) });
}

export function metaFileBody(p, span) {
  return toJson({
    provider: p.id,
    name: p.name,
    home: p.home,
    source: p.source,
    first_date: span.first,
    last_date: span.last,
  });
}

/** The published span {first, last} from meta.json, or null for a provider not published yet. */
export async function readSpan(outDir, p) {
  const meta = await readJson(join(outDir, paths.meta(p)));
  if (!meta) return null;
  if (!isIsoDate(meta.first_date) || !isIsoDate(meta.last_date) || meta.first_date > meta.last_date) {
    throw new Error(`${paths.meta(p)}: bad first_date / last_date`);
  }
  return { first: meta.first_date, last: meta.last_date };
}

/** Every published publication of a provider: Map date → rates, read from its year files. */
export async function readStore(outDir, p) {
  const store = new Map();
  let years;
  try {
    years = await readdir(join(outDir, paths.yearsDir(p)));
  } catch (e) {
    if (e.code === 'ENOENT') return store;
    throw e;
  }
  for (const year of years.filter((y) => /^\d{4}$/.test(y)).sort()) {
    const file = await readJson(join(outDir, paths.year(p, year)));
    if (!file) continue;
    if (file.year !== year || typeof file[p.home] !== 'object') throw new Error(`${paths.year(p, year)}: malformed`);
    for (const [date, rates] of Object.entries(file[p.home])) store.set(date, rates);
  }
  return store;
}

/**
 * Finds, for a date, the newest publication on or before it — the carry-
 * forward rule for days a bank does not publish.
 */
export class PublicationIndex {
  /** @param {Map<string, object>} store */
  constructor(store) {
    this.store = store;
    this.dates = [...store.keys()].sort();
  }

  /** @returns {string | undefined} the publication date in force on `date` */
  dateInForce(date) {
    let lo = 0;
    let hi = this.dates.length - 1;
    let found;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.dates[mid] <= date) {
        found = this.dates[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }
}
