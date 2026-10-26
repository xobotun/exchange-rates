// The tree writer and the update rules, with a stub provider and a
// temporary output directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { addDays, eachDay } from '../src/dates.mjs';
import { planChunks, planWindow, updateProvider, writeProvidersList } from '../src/update.mjs';
import { HISTORY_START } from '../src/history.mjs';
import { PROVIDERS } from '../src/providers/index.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rates-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Every file under `dir` as {relative path: content}. */
async function snapshot(dir) {
  const files = {};
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files[relative(dir, full)] = await readFile(full, 'utf8');
    }
  }
  await walk(dir).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  return files;
}

const readJsonFile = async (dir, path) => JSON.parse(await readFile(join(dir, path), 'utf8'));

/**
 * A fake bank publishing `publications` ({date: rates}). fetchRange behaves
 * like a range source with a 7-day look-back; `failOn(from, to)` can make it throw.
 */
function stubBank(publications, { failOn = () => false, lookback = 7 } = {}) {
  const calls = [];
  return {
    id: 'tst',
    name: 'Test Bank',
    home: 'hom',
    source: 'https://bank.example/rates',
    firstDate: HISTORY_START,
    calls,
    async fetchRange(from, to) {
      calls.push({ from, to });
      if (failOn(from, to)) throw new Error(`bank down for ${from}..${to}`);
      const since = addDays(from, -lookback);
      return {
        publications: Object.entries(publications)
          .filter(([date]) => date >= since && date <= to)
          .map(([date, rates]) => ({ date, rates })),
        raw: [{ path: `raw/tst/${to.slice(0, 4)}/export.csv`, body: Buffer.from(`${from}..${to}\n`) }],
      };
    },
  };
}

const run = (dir, provider, from, to, today = to) => updateProvider({ provider, outDir: dir, from, to, today, http: null });

test('day files exist for every calendar day; non-publication days repeat the newest earlier publication with ITS date', async (t) => {
  const dir = await tempDir(t);
  const bank = stubBank({
    '2026-10-22': { bbb: 2, aaa: 0.5 },
    '2026-10-23': { aaa: 0.25, bbb: 3 }, // Friday
    '2026-10-26': { aaa: 0.125, bbb: 4 }, // Monday
  });
  const result = await run(dir, bank, '2026-10-23', '2026-10-27');
  assert.equal(result.ok, true);

  const expectDate = {
    '2026-10-23': '2026-10-23',
    '2026-10-24': '2026-10-23',
    '2026-10-25': '2026-10-23',
    '2026-10-26': '2026-10-26',
    '2026-10-27': '2026-10-26',
  };
  for (const [day, published] of Object.entries(expectDate)) {
    const body = await readJsonFile(dir, `v1/tst/${day}/currencies/hom.json`);
    assert.equal(body.date, published, day);
    assert.deepEqual(Object.keys(body), ['date', 'hom']);
  }
  const friday = await readFile(join(dir, 'v1/tst/2026-10-24/currencies/hom.json'), 'utf8');
  assert.equal(friday, '{\n  "date": "2026-10-23",\n  "hom": {\n    "aaa": 0.25,\n    "bbb": 3\n  }\n}\n'); // codes sorted

  assert.deepEqual(await readJsonFile(dir, 'v1/tst/latest/currencies/hom.json'), {
    date: '2026-10-26',
    hom: { aaa: 0.125, bbb: 4 },
  });
  assert.deepEqual(await readJsonFile(dir, 'v1/tst/meta.json'), {
    provider: 'tst',
    name: 'Test Bank',
    home: 'hom',
    source: 'https://bank.example/rates',
    first_date: '2026-10-23',
    last_date: '2026-10-27',
  }); // exactly these keys: no `publishes`
  // Year file: publication days inside the published span only (22.10 was only the look-back).
  assert.deepEqual(await readJsonFile(dir, 'v1/tst/years/2026/currencies/hom.json'), {
    year: '2026',
    hom: { '2026-10-23': { aaa: 0.25, bbb: 3 }, '2026-10-26': { aaa: 0.125, bbb: 4 } },
  });
  assert.equal(await readFile(join(dir, 'raw/tst/2026/export.csv'), 'utf8'), '2026-10-23..2026-10-27\n');
});

test('the first day of a window is filled from the look-back publication', async (t) => {
  const dir = await tempDir(t);
  const bank = stubBank({ '2026-10-23': { aaa: 1 }, '2026-10-26': { aaa: 2 } });
  await run(dir, bank, '2026-10-25', '2026-10-26'); // starts on a Sunday
  assert.equal((await readJsonFile(dir, 'v1/tst/2026-10-25/currencies/hom.json')).date, '2026-10-23');
  assert.equal((await readJsonFile(dir, 'v1/tst/meta.json')).first_date, '2026-10-25');
  assert.deepEqual(Object.keys((await readJsonFile(dir, 'v1/tst/years/2026/currencies/hom.json')).hom), ['2026-10-26']);
});

test('a failed fetch writes nothing and leaves existing files untouched', async (t) => {
  const dir = await tempDir(t);
  const pubs = { '2026-10-20': { aaa: 1 }, '2026-10-21': { aaa: 2 } };
  await run(dir, stubBank(pubs), '2026-10-20', '2026-10-21');
  const before = await snapshot(dir);

  const down = stubBank({ ...pubs, '2026-10-22': { aaa: 3 } }, { failOn: () => true });
  const result = await run(dir, down, '2026-10-20', '2026-10-25');
  assert.equal(result.ok, false);
  assert.match(result.error.message, /bank down/);
  assert.deepEqual(await snapshot(dir), before);
});

test('a failed fetch on an empty tree creates no files at all', async (t) => {
  const dir = await tempDir(t);
  const result = await run(dir, stubBank({}, { failOn: () => true }), '2026-10-20', '2026-10-25');
  assert.equal(result.ok, false);
  assert.deepEqual(await snapshot(dir), {});
});

test('invalid data (zero, NaN, bad code, own home currency, no rates) is rejected before anything is written', async (t) => {
  const dir = await tempDir(t);
  for (const rates of [{ aaa: 0 }, { aaa: NaN }, { AAA: 1 }, { hom: 1 }, {}]) {
    const result = await run(dir, stubBank({ '2026-10-20': rates }), '2026-10-20', '2026-10-21');
    assert.equal(result.ok, false, JSON.stringify(rates));
  }
  assert.deepEqual(await snapshot(dir), {});
});

test('no publication on or before the first day → the chunk fails, nothing written', async (t) => {
  const dir = await tempDir(t);
  const result = await run(dir, stubBank({ '2026-10-22': { aaa: 1 } }), '2026-10-20', '2026-10-23');
  assert.equal(result.ok, false);
  assert.match(result.error.message, /no publication on or before 2026-10-20/);
  assert.deepEqual(await snapshot(dir), {});
});

test('the window is capped at today: nothing after today is fetched or written', async (t) => {
  const dir = await tempDir(t);
  const bank = stubBank({ '2026-10-20': { aaa: 1 }, '2026-10-30': { aaa: 9 } });
  await run(dir, bank, '2026-10-20', '2026-11-05', '2026-10-22');
  assert.deepEqual(bank.calls, [{ from: '2026-10-20', to: '2026-10-22' }]);
  assert.equal((await readJsonFile(dir, 'v1/tst/meta.json')).last_date, '2026-10-22');
  assert.equal((await readJsonFile(dir, 'v1/tst/latest/currencies/hom.json')).date, '2026-10-20');
});

test('re-running the same update changes nothing', async (t) => {
  const dir = await tempDir(t);
  const bank = stubBank({ '2026-10-20': { aaa: 1 }, '2026-10-23': { aaa: 2 } });
  assert.ok((await run(dir, bank, '2026-10-20', '2026-10-25')).changed > 0);
  assert.equal((await run(dir, bank, '2026-10-20', '2026-10-25')).changed, 0);
});

test('nightly merges into the tree; a corrected look-back publication rewrites its day files', async (t) => {
  const dir = await tempDir(t);
  await run(dir, stubBank({ '2026-10-23': { aaa: 1 } }), '2026-10-23', '2026-10-25');
  // The bank corrected Friday's rate; the next run's window starts on Monday.
  const corrected = stubBank({ '2026-10-23': { aaa: 1.5 }, '2026-10-26': { aaa: 2 } });
  await run(dir, corrected, '2026-10-26', '2026-10-26');
  for (const day of ['2026-10-23', '2026-10-24', '2026-10-25']) {
    assert.deepEqual(await readJsonFile(dir, `v1/tst/${day}/currencies/hom.json`), { date: '2026-10-23', hom: { aaa: 1.5 } }, day);
  }
  assert.deepEqual((await readJsonFile(dir, 'v1/tst/years/2026/currencies/hom.json')).hom, {
    '2026-10-23': { aaa: 1.5 },
    '2026-10-26': { aaa: 2 },
  });
  const meta = await readJsonFile(dir, 'v1/tst/meta.json');
  assert.deepEqual([meta.first_date, meta.last_date], ['2026-10-23', '2026-10-26']);
});

test('a run after a gap widens the window so the day files stay unbroken', async (t) => {
  const dir = await tempDir(t);
  const pubs = Object.fromEntries([...eachDay('2026-10-01', '2026-10-25')].map((d, i) => [d, { aaa: i + 1 }]));
  await run(dir, stubBank(pubs), '2026-10-01', '2026-10-05');
  const bank = stubBank(pubs);
  await run(dir, bank, '2026-10-20', '2026-10-25'); // nightly after two weeks of silence
  assert.deepEqual(bank.calls, [{ from: '2026-10-06', to: '2026-10-25' }]);
  for (const day of eachDay('2026-10-01', '2026-10-25')) {
    assert.equal((await readJsonFile(dir, `v1/tst/${day}/currencies/hom.json`)).date, day);
  }
});

test('backfill over several years from the history start: one chunk per year, year files per year', async (t) => {
  const dir = await tempDir(t);
  const pubs = {
    '2019-12-20': { aaa: 0.5 }, // look-back seed for the floor, 2019-12-24
    '2019-12-30': { aaa: 1 }, // in force on 2020-01-01..07
    '2020-01-08': { aaa: 2 },
    '2020-12-31': { aaa: 3 },
    '2021-01-05': { aaa: 4 },
    '2022-01-03': { aaa: 5 },
  };
  const bank = stubBank(pubs, { lookback: 21 });
  const result = await run(dir, bank, '2019-06-01', '2022-01-04'); // before the floor: clamped to 2019-12-24
  assert.equal(result.ok, true);
  assert.deepEqual(
    bank.calls.map((c) => `${c.from}..${c.to}`),
    ['2019-12-24..2019-12-31', '2020-01-01..2020-12-31', '2021-01-01..2021-12-31', '2022-01-01..2022-01-04'],
  );
  assert.equal((await readJsonFile(dir, 'v1/tst/meta.json')).first_date, '2019-12-24');
  assert.equal((await readJsonFile(dir, 'v1/tst/2019-12-24/currencies/hom.json')).date, '2019-12-20');
  assert.equal((await readJsonFile(dir, 'v1/tst/2020-01-01/currencies/hom.json')).date, '2019-12-30');
  assert.equal((await readJsonFile(dir, 'v1/tst/2021-01-04/currencies/hom.json')).date, '2020-12-31');
  assert.equal((await readJsonFile(dir, 'v1/tst/2022-01-02/currencies/hom.json')).date, '2021-01-05');
  // 2019 holds the last days of 2019 inside the span: the publication 2020-01-01 resolves to is there.
  assert.deepEqual(await readJsonFile(dir, 'v1/tst/years/2019/currencies/hom.json'), {
    year: '2019',
    hom: { '2019-12-30': { aaa: 1 } },
  });
  assert.deepEqual(await readJsonFile(dir, 'v1/tst/years/2020/currencies/hom.json'), {
    year: '2020',
    hom: { '2020-01-08': { aaa: 2 }, '2020-12-31': { aaa: 3 } },
  });
  assert.deepEqual(Object.keys((await readJsonFile(dir, 'v1/tst/years/2021/currencies/hom.json')).hom), ['2021-01-05']);
  const files = Object.keys(await snapshot(dir));
  assert.equal(files.filter((f) => /^v1\/tst\/\d{4}-\d{2}-\d{2}\//.test(f)).length, 8 + 366 + 365 + 4);
});

test('every bank starts its history on 2019-12-24, a week before the app history', () => {
  assert.equal(HISTORY_START, '2019-12-24');
  for (const p of PROVIDERS) {
    assert.equal(p.firstDate, HISTORY_START, p.id);
    assert.equal('publishes' in p, false, p.id);
  }
});

test('a chunk failing in the middle of a backfill keeps the written part consistent', async (t) => {
  const dir = await tempDir(t);
  const pubs = { '2019-12-30': { aaa: 1 }, '2020-06-01': { aaa: 2 }, '2021-06-01': { aaa: 3 } };
  const bank = stubBank(pubs, { lookback: 21, failOn: (from) => from.startsWith('2021') });
  const result = await run(dir, bank, '2020-01-01', '2022-03-01');
  assert.equal(result.ok, false);
  assert.equal(bank.calls.length, 2); // stops at the failed chunk
  const meta = await readJsonFile(dir, 'v1/tst/meta.json');
  assert.deepEqual([meta.first_date, meta.last_date], ['2020-01-01', '2020-12-31']);
  assert.equal((await readJsonFile(dir, 'v1/tst/latest/currencies/hom.json')).date, '2020-06-01');
  const files = Object.keys(await snapshot(dir));
  assert.equal(files.some((f) => f.includes('2021')), false);
});

test('days the bank reports missing are written as carry-forward days and listed in the result', async (t) => {
  const dir = await tempDir(t);
  const bank = stubBank({ '2026-10-20': { aaa: 1 }, '2026-10-23': { aaa: 2 } });
  const fetchStub = bank.fetchRange;
  bank.fetchRange = async (from, to, ctx) => {
    ctx.missing.push('2026-10-21', '2026-10-22');
    return fetchStub(from, to, ctx);
  };
  const result = await run(dir, bank, '2026-10-20', '2026-10-23');
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, ['2026-10-21', '2026-10-22']);
  assert.equal((await readJsonFile(dir, 'v1/tst/2026-10-22/currencies/hom.json')).date, '2026-10-20');
  assert.equal((await readJsonFile(dir, 'v1/tst/meta.json')).last_date, '2026-10-23');
});

test('a day the bank reports missing but the tree already has (filled by hand) keeps its rates and is not reported', async (t) => {
  const dir = await tempDir(t);
  await run(dir, stubBank({ '2026-10-20': { aaa: 1 }, '2026-10-21': { aaa: 5 }, '2026-10-23': { aaa: 2 } }), '2026-10-20', '2026-10-23');
  const bank = stubBank({ '2026-10-20': { aaa: 1 }, '2026-10-23': { aaa: 2 } });
  const fetchStub = bank.fetchRange;
  bank.fetchRange = async (from, to, ctx) => {
    ctx.missing.push('2026-10-21', '2026-10-22');
    return fetchStub(from, to, ctx);
  };
  const result = await run(dir, bank, '2026-10-20', '2026-10-23');
  assert.deepEqual(result.missing, ['2026-10-22']);
  assert.deepEqual(await readJsonFile(dir, 'v1/tst/2026-10-21/currencies/hom.json'), { date: '2026-10-21', hom: { aaa: 5 } });
});

test('maxYears: a window widened past that many years fetches and writes nothing', async (t) => {
  const dir = await tempDir(t);
  const pubs = { '2024-12-31': { aaa: 1 }, '2025-12-31': { aaa: 2 }, '2026-10-15': { aaa: 3 } };
  await run(dir, stubBank(pubs), '2026-10-15', '2026-10-20');
  const before = await snapshot(dir);

  const bank = stubBank(pubs);
  const result = await updateProvider({ provider: bank, outDir: dir, from: '2020-01-01', to: '2020-12-31', today: '2026-10-25', http: null, maxYears: 2 });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /backfill 2025 first/);
  assert.deepEqual(bank.calls, []);
  assert.deepEqual(await snapshot(dir), before);
});

test('maxYears: the year next to the published span runs, with the part of the year it widens into', async (t) => {
  const dir = await tempDir(t);
  const pubs = { '2024-12-31': { aaa: 1 }, '2025-12-31': { aaa: 2 }, '2026-10-15': { aaa: 3 } };
  await run(dir, stubBank(pubs), '2026-10-15', '2026-10-20');

  const bank = stubBank(pubs);
  const result = await updateProvider({ provider: bank, outDir: dir, from: '2025-01-01', to: '2025-12-31', today: '2026-10-25', http: null, maxYears: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(bank.calls, [
    { from: '2026-01-01', to: '2026-10-14' },
    { from: '2025-01-01', to: '2025-12-31' },
  ]);
  assert.equal((await readJsonFile(dir, 'v1/tst/meta.json')).first_date, '2025-01-01');
});

test('planWindow: floor, cap and widening to the published span', () => {
  const floor = HISTORY_START;
  assert.deepEqual(planWindow({ from: '2019-01-01', to: '2030-01-01', today: '2026-10-25', floor, span: null }), {
    from: '2019-12-24',
    to: '2026-10-25',
  });
  const span = { first: '2026-10-15', last: '2026-10-20' };
  assert.deepEqual(planWindow({ from: '2026-10-24', to: '2026-10-25', today: '2026-10-25', floor, span }), {
    from: '2026-10-21',
    to: '2026-10-25',
  });
  assert.deepEqual(planWindow({ from: '2020-01-01', to: '2020-12-31', today: '2026-10-25', floor, span }), {
    from: '2020-01-01',
    to: '2026-10-14',
  });
  assert.equal(planWindow({ from: '2027-01-01', to: '2027-01-02', today: '2026-10-25', floor, span: null }), null);
});

test('planChunks: upwards from the published span first, then downwards', () => {
  const order = (span) => planChunks('2020-01-01', '2026-10-25', span).map((c) => c.from.slice(0, 4));
  assert.deepEqual(order(null), ['2020', '2021', '2022', '2023', '2024', '2025', '2026']);
  assert.deepEqual(order({ first: '2023-06-01', last: '2023-12-31' }), ['2023', '2024', '2025', '2026', '2022', '2021', '2020']);
  assert.deepEqual(order({ first: '2026-10-26', last: '2026-10-30' }), ['2026', '2025', '2024', '2023', '2022', '2021', '2020']);
});

test('providers.json lists, in registry order, the providers that have a meta.json', async (t) => {
  const dir = await tempDir(t);
  const a = { ...stubBank({ '2026-10-20': { aaa: 1 } }), id: 'aaa', home: 'hom' };
  const b = { ...stubBank({ '2026-10-20': { aaa: 1 } }), id: 'bbb', home: 'hom' };
  const c = { ...stubBank({}), id: 'ccc', home: 'hom' };
  await run(dir, b, '2026-10-20', '2026-10-20');
  await run(dir, a, '2026-10-20', '2026-10-20');
  await writeProvidersList(dir, [a, b, c]);
  assert.deepEqual(await readJsonFile(dir, 'v1/providers.json'), ['aaa', 'bbb']);
});
