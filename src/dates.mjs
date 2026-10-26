// Calendar dates as 'YYYY-MM-DD' strings. All arithmetic is in UTC, so a
// date is a plain calendar day with no time zone attached. ISO strings of
// this shape sort chronologically, so min/max/compare are string ops.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in 'YYYY-MM-DD' form (rejects 2026-02-30). */
export function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function assertIsoDate(s, what = 'date') {
  if (!isIsoDate(s)) throw new Error(`${what} must be YYYY-MM-DD, got ${JSON.stringify(s)}`);
  return s;
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's date in UTC. */
export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Every date from `from` to `to`, both inclusive. */
export function* eachDay(from, to) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

export const minDate = (a, b) => (a <= b ? a : b);
export const maxDate = (a, b) => (a >= b ? a : b);

export const yearOf = (iso) => iso.slice(0, 4);

/** '2026-10-25' → '25.10.2026' (sep '.') or '25/10/2026' (sep '/'). */
export function toDmy(iso, sep) {
  const [y, m, d] = iso.split('-');
  return [d, m, y].join(sep);
}

/** '25.10.2026' or '25/10/2026' → '2026-10-25'; throws on anything else. */
export function fromDmy(s) {
  const m = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(String(s).trim());
  const iso = m && `${m[3]}-${m[2]}-${m[1]}`;
  if (!iso || !isIsoDate(iso)) throw new Error(`not a DD.MM.YYYY date: ${JSON.stringify(s)}`);
  return iso;
}

/** Sorted dates as runs of consecutive days: ['2022-12-20', '2022-12-21', '2022-12-25'] → ['2022-12-20..2022-12-21', '2022-12-25']. */
export function dateRuns(days) {
  const runs = [];
  for (const day of days) {
    const last = runs.at(-1);
    if (last && addDays(last.to, 1) === day) last.to = day;
    else runs.push({ from: day, to: day });
  }
  return runs.map((r) => (r.from === r.to ? r.from : `${r.from}..${r.to}`));
}

/**
 * Splits [from, to] at calendar-year boundaries:
 * 2025-12-20..2026-01-05 → [2025-12-20..2025-12-31], [2026-01-01..2026-01-05].
 */
export function splitByYear(from, to) {
  const chunks = [];
  for (let start = from; start <= to; ) {
    const yearEnd = `${yearOf(start)}-12-31`;
    const end = minDate(yearEnd, to);
    chunks.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return chunks;
}
