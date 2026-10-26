import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateRuns } from '../src/dates.mjs';

test('dateRuns: consecutive days collapse into from..to, across month ends', () => {
  assert.deepEqual(dateRuns([]), []);
  assert.deepEqual(dateRuns(['2022-12-20']), ['2022-12-20']);
  assert.deepEqual(
    dateRuns(['2023-07-28', '2023-07-29', '2023-07-30', '2023-07-31', '2023-08-01', '2023-08-23', '2023-08-24', '2023-12-31']),
    ['2023-07-28..2023-08-01', '2023-08-23..2023-08-24', '2023-12-31'],
  );
});
