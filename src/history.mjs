// The first date the repo publishes, for every bank: the floor of every
// backfill and of each provider's `firstDate`.
//
// The app's own history starts on 2020-01-01 and it looks back up to 7 days
// for a rate (weekends, holidays). Starting a week earlier means that look-
// back always lands on a publication that is in the year files — e.g. CBA
// does not publish from 31 Dec to 7 Jan, so its 2020-01-01..07 day files
// show 2019-12-30, which is in years/2019.
export const HISTORY_START = '2019-12-24';
