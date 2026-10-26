import { eachDay, yearOf } from '../dates.mjs';

/**
 * Shared fetch loop for banks that answer one date per request (NBG, NBK,
 * CBR). Asks for every calendar day of [from, to] in order and keys each
 * answer by the date the BANK reports, not the date asked for: NBG and CBR
 * answer a Sunday with Saturday's publication, which is then simply a
 * duplicate. Asking for `from` itself returns the publication in force on
 * `from`, so no look-back is needed to fill the first day.
 *
 * Each response is kept as served under raw/<id>/<YYYY>/<asked date>.<ext>.
 * Any failed request throws, so the caller writes nothing for this range.
 * An answer `parse` returns null for is the bank saying it has nothing for
 * that day (NBK's lost days): no publication, so the day repeats the previous
 * one, and the day goes into `ctx.missing` for the run to report.
 *
 * @param {object} p
 * @param {string} p.id provider id (raw path)
 * @param {string} p.ext raw file extension
 * @param {(date: string) => string} p.url
 * @param {(body: Buffer) => {date: string, rates: Record<string, number>} | null} p.parse
 */
export async function fetchDaily({ id, ext, url, parse }, from, to, ctx) {
  const byDate = new Map();
  const raw = [];
  for (const asked of eachDay(from, to)) {
    const body = await ctx.http.get(url(asked));
    let publication;
    try {
      publication = parse(body);
    } catch (e) {
      throw new Error(`${id}: cannot parse the answer for ${asked}: ${e.message}`, { cause: e });
    }
    raw.push({ path: `raw/${id}/${yearOf(asked)}/${asked}.${ext}`, body });
    if (publication === null) {
      ctx.log(`${asked}: the bank has no rates for this day, it repeats the previous publication`);
      ctx.missing?.push(asked);
      continue;
    }
    if (publication.date > asked) {
      // Never seen; would mean the bank answers with a future publication.
      throw new Error(`${id}: asked for ${asked}, got a publication dated ${publication.date}`);
    }
    byDate.set(publication.date, publication);
  }
  return { publications: [...byDate.values()], raw };
}
