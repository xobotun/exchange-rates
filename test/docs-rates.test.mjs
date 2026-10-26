import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths,
  assignSlots,
  clampRange,
  codesIn,
  formatRate,
  fromSeconds,
  presetRange,
  publicationsIn,
  readQuery,
  seriesData,
  toSeconds,
  writeQuery,
  yearPublications,
  yearsBetween,
  zoomOut,
} from '../docs/rates.mjs';

const FIRST = '2022-01-01';
const LAST = '2026-10-26';

test('addMonths clamps to the end of a shorter month', () => {
  assert.equal(addMonths('2026-10-26', -1), '2026-09-26');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2024-03-31', -1), '2024-02-29');
  assert.equal(addMonths('2026-01-15', -12), '2025-01-15');
});

test('presetRange ends on the last day and never starts before the first', () => {
  assert.deepEqual(presetRange('1m', FIRST, LAST), { from: '2026-09-26', to: LAST });
  assert.deepEqual(presetRange('ytd', FIRST, LAST), { from: '2026-01-01', to: LAST });
  assert.deepEqual(presetRange('1y', FIRST, LAST), { from: '2025-10-26', to: LAST });
  assert.deepEqual(presetRange('all', FIRST, LAST), { from: FIRST, to: LAST });
  assert.deepEqual(presetRange('1y', '2026-06-01', LAST), { from: '2026-06-01', to: LAST });
  assert.throws(() => presetRange('2w', FIRST, LAST));
});

test('clampRange keeps a range inside the data and puts its ends in order', () => {
  assert.deepEqual(clampRange('2019-12-24', '2030-01-01', FIRST, LAST), { from: FIRST, to: LAST });
  assert.deepEqual(clampRange('2025-05-01', '2025-04-01', FIRST, LAST), { from: '2025-04-01', to: '2025-05-01' });
});

test('zoomOut doubles the span around the middle, inside the data', () => {
  assert.deepEqual(zoomOut('2025-05-11', '2025-05-21', FIRST, LAST), { from: '2025-05-06', to: '2025-05-26' });
  assert.deepEqual(zoomOut('2025-05-11', '2025-05-11', FIRST, LAST), { from: '2025-05-10', to: '2025-05-12' });
  assert.deepEqual(zoomOut('2022-01-05', '2026-10-20', FIRST, LAST), { from: FIRST, to: LAST });
});

test('yearsBetween lists every calendar year the range touches', () => {
  assert.deepEqual(yearsBetween('2024-12-30', '2026-01-02'), ['2024', '2025', '2026']);
  assert.deepEqual(yearsBetween('2025-03-01', '2025-03-01'), ['2025']);
});

test('day ↔ chart x value round-trips, and a dragged position snaps to the nearest day', () => {
  assert.equal(toSeconds('2026-10-23'), Date.UTC(2026, 9, 23) / 1000);
  assert.equal(fromSeconds(toSeconds('2026-10-23')), '2026-10-23');
  assert.equal(fromSeconds(toSeconds('2026-10-23') + 11 * 3600), '2026-10-23');
  assert.equal(fromSeconds(toSeconds('2026-10-23') + 13 * 3600), '2026-10-24');
});

// Shaped like v1/ecb/years/2022/currencies/eur.json: RUB stops in March 2022.
const ECB_2022 = {
  year: '2022',
  eur: {
    '2022-03-02': { usd: 1.1105, gbp: 0.83, rub: 117.2 },
    '2022-01-03': { usd: 1.1355, gbp: 0.8401, rub: 84.89 },
    '2022-03-03': { usd: 1.1076, gbp: 0.8309 },
  },
};

test('yearPublications sorts a year file into dated publications', () => {
  const pubs = yearPublications(ECB_2022, 'eur');
  assert.deepEqual(pubs.map((p) => p.date), ['2022-01-03', '2022-03-02', '2022-03-03']);
  assert.deepEqual(pubs[0].rates, { usd: 1.1355, gbp: 0.8401, rub: 84.89 });
  assert.deepEqual(yearPublications({ year: '2022' }, 'eur'), []);
});

test('the code list comes from the days in range, so RUB disappears after March 2022', () => {
  const pubs = yearPublications(ECB_2022, 'eur');
  assert.deepEqual(codesIn(publicationsIn(pubs, '2022-01-01', '2022-12-31')), ['gbp', 'rub', 'usd']);
  assert.deepEqual(codesIn(publicationsIn(pubs, '2022-03-03', '2022-12-31')), ['gbp', 'usd']);
  assert.deepEqual(publicationsIn(pubs, '2022-03-04', '2022-12-31'), []);
});

test('seriesData aligns codes on the publication days, null where a code is missing', () => {
  const pubs = yearPublications(ECB_2022, 'eur');
  const [xs, usd, rub] = seriesData(pubs, ['usd', 'rub'], false);
  assert.deepEqual(xs, ['2022-01-03', '2022-03-02', '2022-03-03'].map(toSeconds));
  assert.deepEqual(usd, [1.1355, 1.1105, 1.1076]);
  assert.deepEqual(rub, [84.89, 117.2, null]);
});

test('seriesData inverted gives home units per 1 unit of the code', () => {
  const pubs = [{ date: '2026-10-25', rates: { amd: 0.7961783439490445 } }];
  const [, amd] = seriesData(pubs, ['amd'], true);
  assert.ok(Math.abs(amd[0] - 1.256) < 1e-12);
});

test('assignSlots keeps a code its colour when another code is removed', () => {
  const first = assignSlots(['usd', 'gbp', 'jpy']);
  assert.deepEqual([...first], [['usd', 0], ['gbp', 1], ['jpy', 2]]);
  const second = assignSlots(['usd', 'jpy'], first);
  assert.deepEqual([...second], [['usd', 0], ['jpy', 2]]);
  const third = assignSlots(['usd', 'jpy', 'chf'], second);
  assert.equal(third.get('chf'), 1);
});

test('formatRate reads well across the whole span of values', () => {
  assert.equal(formatRate(1.1193), '1.1193');
  assert.equal(formatRate(1.2560000000000002), '1.256');
  assert.equal(formatRate(16726.78), '16,726.78');
  assert.equal(formatRate(0.0019607843137254902), '0.00196078');
  assert.equal(formatRate(6.840002248452893e-7), '6.84e-7');
  assert.equal(formatRate(null), '—');
  assert.equal(formatRate(Infinity), '—');
});

test('readQuery and writeQuery round-trip the page settings', () => {
  const state = { provider: 'nbk', codes: ['usd', 'eur'], from: '2025-01-01', to: '2026-10-26', inverted: true, log: false };
  assert.equal(writeQuery(state), '?p=nbk&c=usd,eur&from=2025-01-01&to=2026-10-26&inv=1');
  assert.deepEqual(readQuery(writeQuery(state)), state);
});

test('readQuery drops what it cannot use', () => {
  assert.deepEqual(readQuery('?p=&c=USD,eu,x1z,gbp&from=2026-02-30&to=nope'), {
    provider: undefined,
    codes: ['usd', 'gbp'],
    from: undefined,
    to: undefined,
    inverted: false,
    log: false,
  });
  assert.equal(readQuery('').codes, undefined);
});
