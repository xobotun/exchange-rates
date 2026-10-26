# exchange-rates

Official exchange rates published by five central banks: the European Central
Bank and the central banks of Georgia, Kazakhstan, Armenia and Russia. The
rates are republished twice a day as static JSON files. They are free and need
no API key. Browsers can read them directly from `raw.githubusercontent.com`,
which sends `Access-Control-Allow-Origin: *`. That covers the banks whose own
sites send no CORS headers (NBK, CBA, CBR).

The layout and file format follow
[fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api), so
code that reads one can read the other.

```
https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1/nbk/latest/currencies/kzt.json
```

## Providers

| id | Bank | Home | Source endpoint | Rates dated |
|---|---|---|---|---|
| `ecb` | European Central Bank | `eur` | `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml` (or `eurofxref-hist.xml` for older dates) | Working days, published around 16:00 CET |
| `nbg` | National Bank of Georgia | `gel` | `https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/?date=YYYY-MM-DD` | Every day until early September 2021; since then never Sunday or Monday |
| `nbk` | National Bank of Kazakhstan | `kzt` | `https://nationalbank.kz/rss/get_rates.cfm?fdate=DD.MM.YYYY` | Every calendar day |
| `cba` | Central Bank of Armenia | `amd` | `https://www.cba.am/en/exchange-rates-archive/export?currencies[]=…&date-from=DD/MM/YYYY&date-to=DD/MM/YYYY` | Working days |
| `cbr` | Central Bank of the Russian Federation | `rub` | `https://www.cbr.ru/scripts/XML_daily.asp?date_req=DD/MM/YYYY` | Tuesday to Saturday (the day a rate takes effect) |

Each bank quotes its own list of currencies, and the lists change over time. In
October 2026 the counts were: ECB 29, NBG 42, NBK 48, CBA 30, CBR 54.

How each bank's source is read (the updater handles all of this):

- **ECB.** Quotes are already "foreign currency per 1 EUR" and are published
  unchanged. There is no date-range query: the updater downloads the 90-day
  file, or the full history (about 8 MB, at most once per run) when it needs
  older dates. No rates on TARGET holidays (1 January, Good Friday, Easter
  Monday, 1 May, 25 and 26 December). RUB is gone since March 2022 and BGN
  since Bulgaria adopted the euro.
- **NBG.** JSON, one request per date. The rate is GEL per `quantity` units,
  and the quantity can change over time (RSD was per 10 in 2020 and is per 100
  now). Since September 2021, rates are set on working days and take effect
  the next day. A request for a Sunday or Monday returns Saturday's rates,
  dated Saturday. The last Sunday with its own rates is 2021-09-05.
- **NBK.** RSS XML, one request per date, KZT per `quant` units. The feed
  answers any date, even a future one, with its newest rates, so the updater
  never asks for a date after today (UTC). It has lost some days the bank did
  publish (see "Maintenance notes").
- **CBA.** CSV export, one request per calendar year. A longer range with
  every currency times out. The list of currencies comes from the SOAP service
  `https://api.cba.am/exchangerates.asmx` (`ISOCodesDetailed`). Each column
  header carries the unit: `"KZT 10"` means AMD per 10 KZT. An empty or `0`
  cell means "not quoted" and is skipped. Gold and silver are quoted in AMD
  per gram and converted to troy ounces. There are no rates over the New Year
  break: nothing between 2019-12-30 and 2020-01-08.
- **CBR.** XML in windows-1251 encoding with comma decimals, one request per
  date, RUB per `Nominal` units. The answer is the rate in force on the date
  asked, dated with the day it took effect. Rates set on a working day take
  effect the next day, so Sunday and Monday get Saturday's rates, and
  1–9 January 2020 all get the rates of 1 January. cbr.ru has at times been
  unreachable from some foreign networks. If GitHub's runners are blocked, only
  `cbr` fails.

## Files

The tree lives under `v1/`. A breaking change would go to `v2/`, and `v1/`
would stay as it is.

```
https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1/providers.json
https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1/ecb/meta.json
https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1/ecb/2026-10-25/currencies/eur.json
https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1/ecb/latest/currencies/eur.json
https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1/ecb/years/2025/currencies/eur.json
```

The pattern is `v1/<provider>/<YYYY-MM-DD | latest | years/YYYY>/currencies/<home>.json`.
Each provider has exactly one currency file: the one for its home currency
(`ecb` → `eur.json`, `nbg` → `gel.json`, `nbk` → `kzt.json`, `cba` →
`amd.json`, `cbr` → `rub.json`).

`raw.githubusercontent.com` caches files for five minutes
(`Cache-Control: max-age=300`). It serves them as `text/plain`, but
`response.json()` parses them anyway.

### Day files

`v1/ecb/2026-10-25/currencies/eur.json` (a Sunday; shortened):

```json
{
  "date": "2026-10-23",
  "eur": {
    "aud": 1.5939,
    "chf": 0.9227,
    "czk": 24.327,
    "gbp": 0.83728,
    "jpy": 175.51,
    "pln": 4.3945,
    "usd": 1.1193
  }
}
```

- **The number is how many units of the code ONE unit of the home currency
  buys.** Here 1 EUR buys 1.1193 USD.
- **Inversion and per-unit quotes.** NBG, NBK, CBA and CBR quote "home
  currency per N units of the foreign one". Those quotes are inverted and
  divided down in one division, `N / quote`, at full double precision with no
  rounding. NBK's 12.56 KZT per 10 AMD becomes `"amd": 0.7961783439490445`.
  The long tail is an artefact of the division, not extra precision.
  `1 / value` gives back the bank's per-unit rate (1.256 KZT per AMD). ECB
  quotes are already per 1 EUR and are published unchanged.
- **Metals** (`xau`, `xag`) are priced per troy ounce, the unit ISO 4217
  uses. CBA quotes them per gram, so they are converted (1 troy ounce =
  31.1034768 g).
- **Codes** are lowercase and three letters long. A file lists only what the
  bank quoted for that publication: ISO 4217 currencies, metals, and the IMF's
  Special Drawing Right (`xdr`). Nothing is invented or derived. A currency the
  bank left blank or at 0 is left out. The home currency never appears in its
  own file, because its rate is 1. Very small numbers are written in exponent
  notation, which is valid JSON (`"xau": 6.840002248452893e-7`).
- **There is a file for every calendar day.** On a day the bank published
  nothing (weekends, holidays), the file repeats the newest earlier
  publication. `date` inside the file always names the publication the rates
  come from. One request for any day therefore always answers, and `date`
  tells you whether it was a fallback. For Sunday 2026-10-25:

  | Day file `…/2026-10-25/…` of | `date` inside |
  |---|---|
  | `ecb`, `cba` | `2026-10-23` (Friday) |
  | `nbg`, `cbr` | `2026-10-24` (Saturday) |
  | `nbk` | `2026-10-25` |

`latest` is the day file for `last_date` in `meta.json`, which is the date of
the most recent run (UTC). The updater writes only dates up to today, so rates
a bank has already set for tomorrow (NBG, CBR) appear in the next morning's run.

### Year files

For backfilling a whole year in one request, `v1/ecb/years/2026/currencies/eur.json` holds:

```json
{
  "year": "2026",
  "eur": {
    "2026-10-20": { "aud": 1.6056, "chf": 0.9237, "usd": 1.1215, … },
    "2026-10-21": { … }
  }
}
```

A year file has one entry per publication (oldest first), not one per calendar
day. Each entry is the same rates object that the day files repeat. It only
holds publications between `first_date` and `last_date`.

### meta.json and providers.json

`v1/nbk/meta.json`:

```json
{
  "provider": "nbk",
  "name": "National Bank of Kazakhstan",
  "home": "kzt",
  "source": "https://nationalbank.kz/rss/get_rates.cfm",
  "first_date": "2019-12-24",
  "last_date": "2026-10-25"
}
```

`first_date` and `last_date` give the span the tree actually holds. Every day
between them has a day file, and there are none outside it (404).
`v1/providers.json` lists the providers that have a `meta.json`:
`["ecb", "nbg", "nbk", "cba", "cbr"]`.

### Differences from fawazahmed0

- The provider is part of the path, and each provider has one file per date:
  its home currency's. There are no files for other base currencies and no
  `currencies.json`.
- `date` in a day file can be earlier than the date in its path (see above).

### raw/

`raw/<provider>/<YYYY>/…` keeps the downloads exactly as each bank served them,
for auditing. Nothing else reads them.

## History

History starts on 2019-12-24 for every bank. Starting a week before 2020 means
that a lookup on any date from 2020-01-01 onward, looking back up to 7 days
for weekends and holidays, always finds a publication in the year files. For
example, CBA's day files for 2020-01-01 to 2020-01-07 show the publication of
2019-12-30, which is in `years/2019`. Nothing older is published.

## Updates

- **Update** (`.github/workflows/update.yml`) runs every day at 06:00 and
  18:00 UTC. GitHub may start scheduled runs late. Each run re-reads
  yesterday and today (UTC) of every bank. By 06:00, NBK, NBG and CBR have
  set today's rates (they set them the day before); by 18:00, ECB and CBA
  have published today's too. A late publication or a correction for
  yesterday is picked up by the next run; a correction to an older date is
  not. If runs were missed, the window grows back to the last published day,
  so no gap appears. The workflow can also be started by hand.
- **Backfill** (`.github/workflows/backfill.yml`) is started by hand, once
  per calendar year, with two inputs:
  - `year`: YYYY, not in the future. Dates before 2019-12-24 are moved up to
    it, so once 2019 is fetched, an earlier year does nothing for the current
    banks.
  - `provider`: `all` or one id.

  Run it newest year first: 2026, then 2025, and so on down to 2019. The
  banks that answer one date per request (NBG, NBK, CBR) need about 365
  requests a year, at no more than two per second, so a year takes a few
  minutes. The banks run in parallel. A bank's window grows to reach the
  dates it already has, so a year that is not next to them would also fetch
  every year in between. Such a bank fails without fetching anything
  (`--max-years 2`), and its log line names the year to run first; the other
  banks still run. A failed year writes nothing for that bank, so running the
  same year again retries it.
- **What both workflows have in common.** Both run `npm test` first. They share
  one concurrency group, so two runs never write at the same time. They commit
  `v1/` and `raw/` as `github-actions[bot]`, and only when a file changed. A
  file is rewritten only when its content differs, and keys are sorted, so a
  diff shows exactly which rates changed.
- **A failed bank leaves its files untouched.** Everything a bank returns is
  fetched, parsed and checked (dates, lowercase three-letter codes, finite
  positive numbers) before anything is written. A failure therefore writes
  nothing for that bank: no partial or empty files. The other banks are still
  committed, and the run is then marked as failed. The one exception is a day
  NBK explicitly says it has no rates for: that day repeats the previous
  publication, the rest is written, and the run gets a warning instead (see
  "Maintenance notes").
- **Requests.** Each bank gets its own HTTP client, which starts at most two
  requests per second. It retries network errors, timeouts, 429 and 5xx
  responses, waiting 2, 4, 8 and then 16 seconds. Its `User-Agent` names this
  repository.

## Usage

```sh
# Newest ECB rates
curl -s https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1/ecb/latest/currencies/eur.json

# Which publication covers a Sunday, and its USD rate
curl -s https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1/ecb/2026-10-25/currencies/eur.json \
  | jq '{date, usd: .eur.usd}'
```

Converting between two currencies the same bank quotes goes through the home
currency: `amount × rates[to] / rates[from]`, with the home currency itself
counted as 1.

```js
const BASE = 'https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1';

// One bank's rates for a day ('latest' or 'YYYY-MM-DD').
async function ratesOn(provider, home, day = 'latest') {
  const res = await fetch(`${BASE}/${provider}/${day}/currencies/${home}.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${provider} ${day}`);
  const body = await res.json();
  return { date: body.date, rates: { ...body[home], [home]: 1 } };
}

function convert(amount, from, to, rates) {
  if (!(from in rates) || !(to in rates)) throw new Error(`no ${from} or ${to} in this set`);
  return (amount * rates[to]) / rates[from];
}

const { date, rates } = await ratesOn('nbk', 'kzt', '2026-10-25');
console.log(date, convert(100, 'eur', 'amd', rates).toFixed(2)); // 2026-10-25 40203.03
```

A conversion like this is a cross rate through the bank's home currency.
Different banks give slightly different crosses for the same pair.

## Running locally

You need Node.js 22 or newer; the workflows use Node 24. There are no
dependencies, so there is nothing to install.

```sh
npm test                                                  # offline: parsers on real responses, writer, update rules, HTTP client

node scripts/update.mjs --out out                         # the last ten days, all banks
node scripts/update.mjs --days 1 --out out                # yesterday and today, as the scheduled runs do
node scripts/update.mjs --from 2026-01-01 --out out       # from a date up to today
node scripts/update.mjs --provider nbk,cba --from 2024-01-01 --to 2024-12-31 --out out
```

| Option | Meaning |
|---|---|
| `--provider id[,id…]` | Only these banks (the option can be repeated). Default: all. |
| `--from YYYY-MM-DD` | First date. Default: `--to` minus `--days`. Dates before 2019-12-24 are moved up to it. |
| `--to YYYY-MM-DD` | Last date. Default: today (UTC). Dates after today are capped to today. |
| `--days N` | Window length when `--from` is not given. Default: 10. |
| `--max-years N` | A bank whose window, grown to reach the dates it already has, spans more than N calendar years fails without fetching anything. The backfill workflow passes 2. Default: no limit. |
| `--out DIR` | Where `v1/` and `raw/` are written. Default: the repository root, which is what the workflows use. `out/` is ignored by git. |

The exit code is 0 on success, 1 when a bank failed (the others are still
written), and 2 for bad arguments. To change the `User-Agent`, set the
`RATES_USER_AGENT` environment variable.

### Adding a bank

1. Create `src/providers/<id>.mjs` with a default export
   `{ id, name, home, source, firstDate: HISTORY_START, fetchRange }`:
   - `home` is the lowercase home currency.
   - `source` goes into `meta.json`.
   - `fetchRange(from, to, ctx)` returns
     `{ publications: [{ date, rates }], raw: [{ path, body }] }`. It must
     include every publication in `[from, to]`, plus at least the newest one on
     or before `from`. Rates must already be normalised: units of each
     lowercase code per one home unit.
   - `fetchRange` throws on any failure and never returns partial results.
   - `ctx` provides `http` (throttled, retrying `get` and `post` that return
     Buffers), `cache` (a `Map` shared across the year chunks of one run),
     `today` and `log`.
   - For a bank that answers one date per request, `fetchDaily` in
     `src/providers/daily.mjs` does the loop. It needs a `url(date)` and a
     `parse(body) → { date, rates }`; NBG, NBK and CBR use it.
   - `src/normalize.mjs` has `foreignPerHome`, `parseDecimal` and `isQuote`.
2. Add the provider to `PROVIDERS` in `src/providers/index.mjs`. Its position
   there is its position in `providers.json`.
3. Add its id to the `provider` options in `.github/workflows/backfill.yml`.
4. Add parser tests that use real responses saved under `test/fixtures/<id>/`.
5. Run the backfill workflow for the new bank, one year at a time from the
   current year back.

### Maintenance notes

- The scheduled runs cover only yesterday and today. On a fresh repository,
  run the backfill for each year, newest first, from the current year down to
  2019, to publish the history. Until then `first_date` reaches back only as
  far as the runs so far have gone.
- `raw/` grows by one file per day for each of NBG, NBK and CBR (about 9–14 KB
  each). ECB and CBA overwrite one file per year, and git history keeps the
  older versions.
- **NBK's RSS feed has lost some days.** It answers 2023-07-28 to 2023-08-28,
  except 2023-08-22, with `<info>на выбранную дату информации нет.</info>`
  ("no information for the selected date") and no rates, and the HTML report
  on nationalbank.kz has the same hole. The bank did publish those days, and
  the Excel export of the same page has every one of them. The workflows
  write such a day as a repeat of the previous publication (its `date` names
  that one) and put a warning on the run listing the days. To fill them,
  run by hand `node scripts/nbk-excel-fill.mjs --from … --to …` for a range
  around the warned days, inside what the tree holds and including at least
  one day the feed did answer, e.g. the calendar month. It makes one export
  request per year of the range and nothing else, checks that the export
  matches the stored rates exactly on every day both have, and only then
  fills the missing days. The export is kept under
  `raw/nbk/<YYYY>/excel-<from>_<to>.xlsx`. 2023 was filled from the export
  for 2023-07-23..2023-08-31.

## Disclaimer

The rates are each bank's official rates as the bank published them. The only
changes are the normalisation described above (inversion, per-unit division,
grams to troy ounces). They are for information only and are not an offer to
buy or sell. They come with no warranty of accuracy, completeness or
availability. The data belongs to the banks, and each bank's own terms of use
apply to it. This project is not affiliated with any of the banks.

## License

The code is under the [MIT License](LICENSE). The rates themselves are subject
to the terms of the bank that published them.
