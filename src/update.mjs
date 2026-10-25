// Updating one provider's part of the tree: fetch, merge into the published
// publications, regenerate the derived files. The rules (README "Updating"):
//
// - The window is capped at today (UTC) and floored at the provider's
//   firstDate, then widened to touch the span already published, so the day
//   files always cover one unbroken run of dates.
// - It is processed in calendar-year chunks, starting next to the published
//   span (upwards first, then downwards), so a chunk that fails leaves an
//   unbroken, consistent tree behind: everything before it is written,
//   nothing of it is.
// - Within a chunk nothing is written until the fetch succeeded, parsed,
//   validated, and every day file of the chunk has a publication to show.

import { join } from 'node:path';
import { PROVIDERS } from './providers/index.mjs';
import { addDays, eachDay, isIsoDate, maxDate, minDate, splitByYear, yearOf } from './dates.mjs';
import { readJson, toJson, writeIfChanged } from './fsutil.mjs';
import {
  PublicationIndex,
  dayFileBody,
  metaFileBody,
  paths,
  readSpan,
  readStore,
  sameRates,
  yearFileBody,
} from './tree.mjs';

/**
 * The dates to (re)build: [from, to] capped at today, floored at `floor`, and
 * widened so it overlaps or touches the published `span`. Null if empty.
 */
export function planWindow({ from, to, today, floor, span }) {
  let start = maxDate(from, floor);
  let end = minDate(to, today);
  if (span) {
    start = minDate(start, addDays(span.last, 1));
    end = maxDate(end, addDays(span.first, -1));
  }
  return start <= end ? { from: start, to: end } : null;
}

/**
 * Year chunks of the window, in an order that keeps the published span
 * unbroken after every chunk: those reaching into or above the span go
 * upwards, those wholly below it go downwards.
 */
export function planChunks(from, to, span) {
  const chunks = splitByYear(from, to);
  if (!span) return chunks;
  const below = chunks.filter((c) => c.to < span.first).reverse();
  const rest = chunks.filter((c) => c.to >= span.first);
  return [...rest, ...below];
}

/** Rejects anything that must never reach a published file. */
export function validatePublications(p, publications) {
  if (!Array.isArray(publications) || publications.length === 0) {
    throw new Error('the source returned no publications');
  }
  const seen = new Set();
  for (const { date, rates } of publications) {
    if (!isIsoDate(date)) throw new Error(`bad publication date ${JSON.stringify(date)}`);
    if (seen.has(date)) throw new Error(`publication ${date} returned twice`);
    seen.add(date);
    const codes = Object.keys(rates ?? {});
    if (codes.length === 0) throw new Error(`publication ${date} has no rates`);
    for (const code of codes) {
      const value = rates[code];
      if (!/^[a-z]{3}$/.test(code)) throw new Error(`publication ${date}: bad code ${JSON.stringify(code)}`);
      if (code === p.home) throw new Error(`publication ${date}: quotes its own home currency`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`publication ${date}: bad rate ${code}=${value}`);
      }
    }
  }
}

/**
 * Plans every file one chunk changes, without touching the disk.
 * @returns {{files: {path: string, content: string|Buffer}[], store: Map, span: {first, last}}}
 */
export function planChunkFiles(p, { chunk, fetched, raw, store, span }) {
  const newSpan = span
    ? { first: minDate(span.first, chunk.from), last: maxDate(span.last, chunk.to) }
    : { first: chunk.from, last: chunk.to };

  const merged = new Map(store);
  let regenFrom = chunk.from;
  for (const { date, rates } of fetched) {
    if (date > chunk.to) continue; // belongs to a later chunk
    if (date >= newSpan.first && date < regenFrom && !sameRates(store.get(date), rates)) regenFrom = date;
    merged.set(date, rates);
  }
  // Days after the chunk that carry its last publication forward (weekend
  // after a Friday at the chunk's end) are rebuilt with it.
  let regenTo = chunk.to;
  while (regenTo < newSpan.last && !merged.has(addDays(regenTo, 1))) regenTo = addDays(regenTo, 1);

  const index = new PublicationIndex(merged);
  const files = raw.map(({ path, body }) => ({ path, content: body }));

  const inSpan = (date) => date >= newSpan.first && date <= newSpan.last;
  for (let y = Number(yearOf(regenFrom)); y <= Number(yearOf(regenTo)); y++) {
    const year = String(y);
    const publications = [...merged]
      .filter(([date]) => yearOf(date) === year && inSpan(date))
      .map(([date, rates]) => ({ date, rates }));
    if (publications.length > 0) files.push({ path: paths.year(p, year), content: yearFileBody(p, year, publications) });
  }

  const dayBody = (day) => {
    const source = index.dateInForce(day);
    if (!source) throw new Error(`no publication on or before ${day}: nothing to show for that day`);
    return dayFileBody(p, source, merged.get(source));
  };
  for (const day of eachDay(regenFrom, regenTo)) files.push({ path: paths.day(p, day), content: dayBody(day) });
  files.push({ path: paths.latest(p), content: dayBody(newSpan.last) });
  files.push({ path: paths.meta(p), content: metaFileBody(p, newSpan) });

  return { files, store: merged, span: newSpan };
}

/**
 * Updates one provider in `outDir`. With `maxYears`, a window that would span
 * more year chunks than that (a backfill year far from the published span,
 * widened to join it) fails before anything is fetched.
 * @returns {Promise<{id: string, ok: boolean, error?: Error, changed: number, span: object|null, chunks: object[]}>}
 */
export async function updateProvider({ provider: p, outDir, from, to, today, http, maxYears, cache = new Map(), log = () => {} }) {
  const result = { id: p.id, ok: true, changed: 0, span: null, chunks: [] };
  let span = await readSpan(outDir, p);
  result.span = span;
  const window = planWindow({ from, to, today, floor: p.firstDate, span });
  if (!window) {
    log(`nothing to do for ${from}..${to}`);
    return result;
  }
  if (window.from !== maxDate(from, p.firstDate) || window.to !== minDate(to, today)) {
    log(`window ${window.from}..${window.to} (capped at today / widened to join the published ${span?.first}..${span?.last})`);
  }

  const chunks = planChunks(window.from, window.to, span);
  if (maxYears && chunks.length > maxYears) {
    const next = span && (window.from < span.first ? Number(yearOf(span.first)) - 1 : Number(yearOf(span.last)) + 1);
    const message =
      `${window.from}..${window.to} spans ${chunks.length} years (at most ${maxYears})` +
      (span ? ` to join the published ${span.first}..${span.last}: backfill ${next} first` : '');
    log(`FAILED, nothing fetched: ${message}`);
    return { ...result, ok: false, error: new Error(message) };
  }

  let store = await readStore(outDir, p);
  const ctx = { http, cache, today, log };
  for (const chunk of chunks) {
    try {
      const { publications, raw } = await p.fetchRange(chunk.from, chunk.to, ctx);
      validatePublications(p, publications);
      const plan = planChunkFiles(p, { chunk, fetched: publications, raw, store, span });
      let changed = 0;
      for (const file of plan.files) if (await writeIfChanged(join(outDir, file.path), file.content)) changed++;
      ({ store, span } = plan);
      result.changed += changed;
      result.span = span;
      result.chunks.push({ ...chunk, changed });
      log(`${chunk.from}..${chunk.to}: ${changed} file(s) changed`);
    } catch (error) {
      log(`${chunk.from}..${chunk.to}: FAILED, nothing written for it: ${error.message}`);
      return { ...result, ok: false, error };
    }
  }
  return result;
}

/** Rewrites v1/providers.json: registry order, providers that have a meta.json. */
export async function writeProvidersList(outDir, providers = PROVIDERS) {
  const ids = [];
  for (const p of providers) if (await readJson(join(outDir, paths.meta(p)))) ids.push(p.id);
  if (ids.length === 0) return false;
  return writeIfChanged(join(outDir, paths.providers()), toJson(ids));
}
