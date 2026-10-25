import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foreignPerHome, isQuote, parseDecimal } from '../src/normalize.mjs';
import { addDays, fromDmy, isIsoDate, splitByYear, toDmy } from '../src/dates.mjs';

test('foreignPerHome: per-N quotes are divided down and inverted in one division', () => {
  // CBA: 7.9608 AMD per 10 KZT → 1.2561551602853984 KZT per AMD
  assert.equal(foreignPerHome(7.9608, 10), 10 / 7.9608);
  assert.equal(foreignPerHome(7.9608, 10), 1.2561551602853984);
  // NBK: 451.05 KZT per 1 USD → USD per KZT, full double precision
  assert.equal(foreignPerHome(451.05), 1 / 451.05);
  assert.equal(foreignPerHome(451.05), 0.0022170491076377342);
});

test('parseDecimal: dot and comma decimals; anything else is NaN', () => {
  assert.equal(parseDecimal('56,4250'), 56.425);
  assert.equal(parseDecimal(' 1.1193 '), 1.1193);
  assert.equal(parseDecimal('48751'), 48751);
  for (const bad of ['', '-', 'N/A', '1.2.3', '-5', undefined, null]) assert.ok(Number.isNaN(parseDecimal(bad)), String(bad));
});

test('isQuote: zero, negative and non-finite are "not quoted"', () => {
  assert.equal(isQuote(0), false);
  assert.equal(isQuote(-1), false);
  assert.equal(isQuote(Infinity), false);
  assert.equal(isQuote(NaN), false);
  assert.equal(isQuote(0.0001), true);
});

test('dates: arithmetic and formats', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(toDmy('2026-10-05', '/'), '05/10/2026');
  assert.equal(fromDmy('05.10.2026'), '2026-10-05');
  assert.throws(() => fromDmy('31.02.2026'));
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate('2026-10-25'), true);
  assert.deepEqual(splitByYear('2024-12-30', '2026-01-02'), [
    { from: '2024-12-30', to: '2024-12-31' },
    { from: '2025-01-01', to: '2025-12-31' },
    { from: '2026-01-01', to: '2026-01-02' },
  ]);
});
