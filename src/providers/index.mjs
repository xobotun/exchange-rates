// The registry. Order = order in v1/providers.json.
//
// A provider is { id, name, home, source, firstDate, fetchRange }:
// - `home`: lowercase home currency, the base of every published file.
// - `firstDate`: the floor of the published history. Nothing before it is
//   fetched for publication (HISTORY_START everywhere, see ../history.mjs).
//   meta.json's first_date is the first day file actually written, which
//   equals this once the backfill has run.
// - `fetchRange(from, to, ctx)` → { publications: [{date, rates}], raw: [{path, body}] }:
//   every publication in [from, to] plus at least the newest one on or before
//   `from` (so `from` can be filled), rates as {code: units of code per ONE
//   home unit}, lowercase codes. Throws on any failure — partial results are
//   never returned.

import ecb from './ecb.mjs';
import nbg from './nbg.mjs';
import nbk from './nbk.mjs';
import cba from './cba.mjs';
import cbr from './cbr.mjs';

export const PROVIDERS = [ecb, nbg, nbk, cba, cbr];

export function providerById(id) {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`unknown provider ${JSON.stringify(id)}; known: ${PROVIDERS.map((p) => p.id).join(', ')}`);
  return provider;
}
