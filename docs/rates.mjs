// The rates page's data logic, free of the DOM so `npm test` can cover it.
// GitHub Pages publishes docs/ on its own, so nothing here may import from
// src/. Dates are 'YYYY-MM-DD' strings, as in the data files; string order is
// date order.

/** Lines on one chart. The palette has this many colours, and a colour is never reused. */
export const MAX_SERIES = 8;

export const PRESETS = [
  ['1m', '1M'],
  ['3m', '3M'],
  ['6m', '6M'],
  ['ytd', 'YTD'],
  ['1y', '1Y'],
  ['all', 'All'],
];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86400;

/** True for a real calendar date in 'YYYY-MM-DD' form (rejects 2026-02-30). */
export function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Calendar months, clamped to the month's last day: ('2026-03-31', -1) → '2026-02-28'. */
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

export const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / (DAY * 1000);

const clamp = (iso, first, last) => (iso < first ? first : iso > last ? last : iso);

/** The chart's x values: midnight UTC of the day, in seconds. */
export const toSeconds = (iso) => Date.parse(`${iso}T00:00:00Z`) / 1000;

/** A chart x value back to the nearest calendar day. */
export const fromSeconds = (ts) => new Date(Math.round(ts / DAY) * DAY * 1000).toISOString().slice(0, 10);

/** A range moved inside [first, last], with its ends swapped if they were backwards. */
export function clampRange(from, to, first, last) {
  const a = clamp(from, first, last);
  const b = clamp(to, first, last);
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** A preset range ending on the bank's last day, cut off at its first. */
export function presetRange(preset, first, last) {
  const from = {
    '1m': () => addMonths(last, -1),
    '3m': () => addMonths(last, -3),
    '6m': () => addMonths(last, -6),
    ytd: () => `${last.slice(0, 4)}-01-01`,
    '1y': () => addMonths(last, -12),
    all: () => first,
  }[preset];
  if (!from) throw new Error(`unknown preset ${JSON.stringify(preset)}`);
  return clampRange(from(), last, first, last);
}

/** Double-click with nothing to go back to: twice the span around the same middle. */
export function zoomOut(from, to, first, last) {
  const half = Math.max(1, Math.ceil(daysBetween(from, to) / 2));
  return clampRange(addDays(from, -half), addDays(to, half), first, last);
}

/** Calendar years a range touches: ('2024-12-30', '2026-01-02') → ['2024', '2025', '2026']. */
export function yearsBetween(from, to) {
  const years = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) years.push(String(y));
  return years;
}

/** A year file's body → its publications, oldest first: [{ date, rates }]. */
export function yearPublications(body, home) {
  return Object.entries(body[home] ?? {})
    .map(([date, rates]) => ({ date, rates }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The publications dated inside [from, to]. */
export const publicationsIn = (pubs, from, to) => pubs.filter((p) => p.date >= from && p.date <= to);

/** Every code quoted at least once in `pubs`, sorted. */
export function codesIn(pubs) {
  const codes = new Set();
  for (const p of pubs) for (const code of Object.keys(p.rates)) codes.add(code);
  return [...codes].sort();
}

/**
 * The chart's aligned arrays: [x, ...one per code]. A code the bank did not
 * quote that day is null. Stored values are units of the code per 1 home
 * unit; `inverted` turns them into home units per 1 unit of the code.
 */
export function seriesData(pubs, codes, inverted) {
  const xs = pubs.map((p) => toSeconds(p.date));
  const ys = codes.map((code) =>
    pubs.map((p) => {
      const v = p.rates[code];
      if (v === undefined) return null;
      return inverted ? 1 / v : v;
    }),
  );
  return [xs, ...ys];
}

/**
 * A palette slot (0-based) per selected code. A code keeps the slot it already
 * had, so removing one line never recolours the others; a new code takes the
 * lowest free slot.
 */
export function assignSlots(codes, previous = new Map()) {
  const slots = new Map();
  for (const code of codes) if (previous.has(code)) slots.set(code, previous.get(code));
  const used = new Set(slots.values());
  for (const code of codes) {
    if (slots.has(code)) continue;
    let slot = 0;
    while (used.has(slot)) slot++;
    slots.set(code, slot);
    used.add(slot);
  }
  return slots;
}

const wholeFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const fractionFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });

/**
 * A rate for people to read. Values run from about 1e-7 (ounces of gold per
 * dram) to millions (drams per ounce), so small ones get significant digits
 * and the tiniest an exponent. This also hides the division's long tail.
 */
export function formatRate(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1) return wholeFormat.format(v);
  if (a >= 1e-4 || a === 0) return fractionFormat.format(v);
  return Number(v.toPrecision(6)).toExponential();
}

/** The page's settings from its query string; anything missing or malformed is undefined. */
export function readQuery(search) {
  const q = new URLSearchParams(search);
  const date = (key) => (isIsoDate(q.get(key)) ? q.get(key) : undefined);
  const codes = q.has('c')
    ? q.get('c').toLowerCase().split(',').filter((c) => /^[a-z]{3}$/.test(c))
    : undefined;
  return {
    provider: q.get('p') || undefined,
    codes,
    from: date('from'),
    to: date('to'),
    inverted: q.get('inv') === '1',
    log: q.get('log') === '1',
  };
}

/** The query string readQuery reads back. Every value is [a-z0-9,-], so nothing needs escaping. */
export function writeQuery({ provider, codes, from, to, inverted, log }) {
  let s = `?p=${provider}&c=${codes.join(',')}&from=${from}&to=${to}`;
  if (inverted) s += '&inv=1';
  if (log) s += '&log=1';
  return s;
}
