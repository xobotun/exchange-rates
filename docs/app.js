// The rates page: one bank, up to MAX_SERIES of its currencies, any range of
// days, drawn with uPlot (a global, loaded by index.html). The data logic is
// in rates.mjs; this file is the DOM and the chart.

import {
  MAX_SERIES,
  PRESETS,
  addDays,
  assignSlots,
  clampRange,
  codesIn,
  daysBetween,
  formatRate,
  fromSeconds,
  isIsoDate,
  presetRange,
  publicationsIn,
  readQuery,
  seriesData,
  writeQuery,
  yearPublications,
  yearsBetween,
  zoomOut,
} from './rates.mjs';

// Served from a checkout (repo root, page at /docs/), the page reads that
// checkout's v1/. Anywhere else, GitHub Pages included, it reads main on GitHub.
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const BASE = LOCAL ? '../v1' : 'https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1';

const DEFAULTS = { provider: 'ecb', codes: ['usd', 'gbp'], preset: '1y' };

const $ = (id) => document.getElementById(id);
const el = {
  provider: $('provider'),
  from: $('from'),
  to: $('to'),
  presets: $('presets'),
  dirHome: $('dir-home'),
  dirForeign: $('dir-foreign'),
  log: $('log'),
  status: $('status'),
  picked: $('picked'),
  filter: $('filter'),
  codes: $('codes'),
  limit: $('limit'),
  caption: $('caption'),
  chartWrap: $('chart-wrap'),
  chart: $('chart'),
  empty: $('empty'),
  tableBox: $('table-box'),
  table: $('table'),
  source: $('source'),
};

const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency', fallback: 'none' });
const currencyName = (code) => currencyNames.of(code.toUpperCase()) ?? '';
const weekday = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' });
const dayLabel = (ts) => `${fromSeconds(ts)}, ${weekday.format(new Date(ts * 1000))}`;

const state = { provider: null, codes: [], from: null, to: null, inverted: false, log: false };

let metas = new Map();
const yearCache = new Map(); // 'ecb/2025' → Promise of that year's publications
let pubs = []; // publications inside the range
let available = []; // codes quoted at least once inside the range
let slots = new Map(); // code → palette slot
const hidden = new Set(); // codes switched off in the legend
const zoomHistory = []; // ranges before each drag-zoom, for double-click
let plot = null;
let listed = ''; // which code list #codes currently holds
let loadSeq = 0;

async function getJson(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

/** One bank's publications for one year, fetched once per page load. */
function loadYear(meta, year) {
  const key = `${meta.provider}/${year}`;
  if (!yearCache.has(key)) {
    const pending = getJson(`${meta.provider}/years/${year}/currencies/${meta.home}.json`)
      .then((body) => yearPublications(body, meta.home));
    pending.catch(() => yearCache.delete(key)); // so a failed year is fetched again next time
    yearCache.set(key, pending);
  }
  return yearCache.get(key);
}

function showStatus(text) {
  el.status.textContent = text;
  el.status.hidden = !text;
}

async function start() {
  try {
    const ids = await getJson('providers.json');
    const list = await Promise.all(ids.map((id) => getJson(`${id}/meta.json`)));
    metas = new Map(list.map((m) => [m.provider, m]));
  } catch (err) {
    showStatus(`Could not load the list of banks: ${err.message}`);
    return;
  }

  for (const m of metas.values()) el.provider.append(new Option(`${m.name} · ${m.home.toUpperCase()}`, m.provider));
  for (const [preset, label] of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.preset = preset;
    button.textContent = label;
    el.presets.append(button);
  }

  const q = readQuery(location.search);
  state.provider = [q.provider, DEFAULTS.provider].find((id) => metas.has(id)) ?? metas.keys().next().value;
  const meta = metas.get(state.provider);
  Object.assign(
    state,
    q.from || q.to
      ? clampRange(q.from ?? meta.first_date, q.to ?? meta.last_date, meta.first_date, meta.last_date)
      : presetRange(DEFAULTS.preset, meta.first_date, meta.last_date),
  );
  state.codes = (q.codes ?? DEFAULTS.codes).slice(0, MAX_SERIES);
  state.inverted = q.inverted;
  state.log = q.log;

  bindControls();
  await refresh();
}

/** Loads the year files the range needs (once each), then redraws everything from `state`. */
async function refresh() {
  const seq = ++loadSeq;
  const meta = metas.get(state.provider);
  syncControls(meta);
  el.chartWrap.classList.add('loading');
  let years;
  try {
    years = await Promise.all(yearsBetween(state.from, state.to).map((year) => loadYear(meta, year)));
  } catch (err) {
    if (seq === loadSeq) {
      showStatus(`Could not load the ${meta.name} rates: ${err.message}`);
      el.chartWrap.classList.remove('loading');
    }
    return;
  }
  if (seq !== loadSeq) return; // a newer refresh has started meanwhile
  showStatus('');

  pubs = publicationsIn(years.flat(), state.from, state.to);
  available = codesIn(pubs);
  // A range with no publications at all (a holiday, a weekend) keeps the selection for the next range.
  if (pubs.length) state.codes = state.codes.filter((code) => available.includes(code));
  slots = assignSlots(state.codes, slots);
  history.replaceState(null, '', writeQuery(state));

  syncControls(meta);
  renderCodes();
  renderChart();
  renderTable();
  el.chartWrap.classList.remove('loading');
}

function setRange({ from, to }) {
  const meta = metas.get(state.provider);
  Object.assign(state, clampRange(from, to, meta.first_date, meta.last_date));
  refresh();
}

function syncControls(meta) {
  const home = meta.home.toUpperCase();
  const example = state.codes[0]?.toUpperCase() ?? 'X';
  el.provider.value = state.provider;
  for (const input of [el.from, el.to]) {
    input.min = meta.first_date;
    input.max = meta.last_date;
  }
  el.from.value = state.from;
  el.to.value = state.to;
  for (const button of el.presets.children) {
    const range = presetRange(button.dataset.preset, meta.first_date, meta.last_date);
    button.setAttribute('aria-pressed', String(range.from === state.from && range.to === state.to));
  }
  el.dirHome.textContent = `1 ${home} = … ${example}`;
  el.dirForeign.textContent = `1 ${example} = … ${home}`;
  document.querySelector(`input[name="direction"][value="${state.inverted ? 'foreign' : 'home'}"]`).checked = true;
  el.log.checked = state.log;
  el.caption.textContent = state.inverted
    ? `${home} for 1 unit of each currency`
    : `Units of each currency for 1 ${home}`;

  const link = document.createElement('a');
  link.href = meta.source.startsWith('https://') ? meta.source : '#';
  link.textContent = new URL(meta.source).hostname;
  el.source.replaceChildren(
    `${meta.name}: publications from ${meta.first_date} to ${meta.last_date}, from `,
    link,
    '. The files are updated twice a day.',
  );
}

function codeRow(code) {
  const row = document.createElement('label');
  row.className = 'code';
  row.dataset.code = code;
  const name = currencyName(code);
  row.dataset.search = `${code} ${name}`.toLowerCase();
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = code;
  const key = document.createElement('span');
  key.className = 'key';
  const id = document.createElement('span');
  id.className = 'code-id';
  id.textContent = code.toUpperCase();
  const label = document.createElement('span');
  label.className = 'code-name';
  label.textContent = name;
  label.title = name;
  row.append(input, key, id, label);
  return row;
}

function applyFilter() {
  const needle = el.filter.value.trim().toLowerCase();
  for (const row of el.codes.children) row.hidden = needle !== '' && !row.dataset.search.includes(needle);
}

function renderCodes() {
  // Rebuilt only when the list itself changes, so ticking a box keeps the scroll position.
  const key = `${state.provider}:${available.join(',')}`;
  if (key !== listed) {
    listed = key;
    el.codes.replaceChildren(...available.map(codeRow));
    applyFilter();
  }
  const full = state.codes.length >= MAX_SERIES;
  for (const row of el.codes.children) {
    const on = state.codes.includes(row.dataset.code);
    const input = row.querySelector('input');
    input.checked = on;
    input.disabled = full && !on;
    row.classList.toggle('disabled', input.disabled);
    row.querySelector('.key').style.background = on ? `var(--series-${slots.get(row.dataset.code) + 1})` : 'transparent';
  }
  el.picked.textContent = available.length
    ? `Currencies · ${state.codes.length} of ${available.length}`
    : 'Currencies · none in these days';
  el.limit.textContent = `${MAX_SERIES} at most: each line needs a colour of its own.`;
  el.limit.hidden = !full;
}

// uPlot's time labels with day-month order instead of its US month/day:
// [tick spacing, label, label when the year changes, …] (see uPlot's axes docs).
const DAY = 86400;
const X_LABELS = [
  [DAY * 365, '{YYYY}', null, null, null, null, null, null, 1],
  [DAY * 28, '{MMM}', '\n{YYYY}', null, null, null, null, null, 1],
  [DAY, '{D} {MMM}', '\n{YYYY}', null, null, null, null, null, 1],
  [3600, '{HH}:{mm}', '\n{D} {MMM} {YYYY}', null, '\n{D} {MMM}', null, null, null, 1],
];

const chartHeight = () => Math.round(Math.min(480, Math.max(280, window.innerHeight * 0.5)));

/** Room for the longest y label: rates run from 1e-7 to millions. */
function yAxisSize(u, values, axisIdx, cycleNum) {
  const axis = u.axes[axisIdx];
  if (cycleNum > 1) return axis._size;
  let size = axis.ticks.size + axis.gap;
  const longest = (values ?? []).reduce((a, v) => (v.length > a.length ? v : a), '');
  if (longest) {
    u.ctx.font = axis.font[0];
    size += u.ctx.measureText(longest).width / uPlot.pxRatio;
  }
  return Math.ceil(size);
}

/** Every visible line's value on the hovered day, beside the cursor. */
function tooltipPlugin() {
  const box = document.createElement('div');
  box.className = 'tooltip';
  box.hidden = true;
  const text = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = content;
    return node;
  };
  return {
    hooks: {
      init: (u) => u.over.append(box),
      setCursor: (u) => {
        const { left, top, idx } = u.cursor;
        if (idx == null || left < 0) {
          box.hidden = true;
          return;
        }
        const rows = [];
        u.series.forEach((s, i) => {
          if (i === 0 || !s.show) return;
          const row = text('div', 'tooltip-row', '');
          const key = text('span', 'key', '');
          key.style.background = s.stroke(u, i);
          row.append(key, text('b', '', formatRate(u.data[i][idx])), text('span', '', s.label));
          rows.push(row);
        });
        box.replaceChildren(text('div', 'tooltip-day', dayLabel(u.data[0][idx])), ...rows);
        box.hidden = false;
        const gap = 14;
        const right = left + gap + box.offsetWidth <= u.over.clientWidth;
        const x = right ? left + gap : Math.max(0, left - gap - box.offsetWidth);
        const y = Math.max(0, Math.min(top - box.offsetHeight / 2, u.over.clientHeight - box.offsetHeight));
        box.style.transform = `translate(${x}px, ${y}px)`;
      },
    },
  };
}

function zoomToSelection(u) {
  const { left, width } = u.select;
  if (width < 1) return;
  const from = fromSeconds(u.posToVal(left, 'x'));
  const to = fromSeconds(u.posToVal(left + width, 'x'));
  u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
  if (from >= to) return;
  zoomHistory.push({ from: state.from, to: state.to });
  setRange({ from, to });
}

function zoomBack() {
  const meta = metas.get(state.provider);
  setRange(zoomHistory.pop() ?? zoomOut(state.from, state.to, meta.first_date, meta.last_date));
}

function rememberShown(u, i, opts) {
  if (!i || opts?.show == null) return;
  const code = state.codes[i - 1];
  if (opts.show) hidden.delete(code);
  else hidden.add(code);
}

function renderChart() {
  plot?.destroy();
  plot = null;
  const drawable = pubs.length > 0 && state.codes.length > 0;
  el.empty.textContent = pubs.length
    ? 'Pick a currency to draw its line.'
    : `The bank published nothing from ${state.from} to ${state.to}.`;
  el.empty.hidden = drawable;
  if (!drawable) return;

  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();
  const axis = {
    stroke: token('--text-muted'),
    grid: { stroke: token('--grid'), width: 1 },
    ticks: { stroke: token('--grid'), width: 1, size: 4 },
    font: '12px system-ui, -apple-system, "Segoe UI", sans-serif',
  };
  plot = new uPlot(
    {
      width: el.chart.clientWidth,
      height: chartHeight(),
      // The x values are UTC midnights; without this, anyone west of UTC sees every day labelled a day early.
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC'),
      scales: { x: { time: true }, y: state.log ? { distr: 3, log: 10 } : {} },
      axes: [
        { ...axis, values: X_LABELS },
        { ...axis, size: yAxisSize, values: (u, splits) => splits.map(formatRate) },
      ],
      series: [
        {},
        ...state.codes.map((code) => ({
          label: code.toUpperCase(),
          stroke: token(`--series-${slots.get(code) + 1}`),
          width: 2,
          spanGaps: true,
          points: { fill: token('--surface') },
          show: !hidden.has(code),
        })),
      ],
      cursor: { y: false, drag: { x: true, y: false, setScale: false }, points: { size: 8, width: 2 } },
      legend: { live: false },
      hooks: { setSelect: [zoomToSelection], setSeries: [rememberShown] },
      plugins: [tooltipPlugin()],
    },
    seriesData(pubs, state.codes, state.inverted),
    el.chart,
  );
  plot.over.addEventListener('dblclick', zoomBack);
}

function renderTable() {
  if (!el.tableBox.open || !pubs.length || !state.codes.length) {
    el.table.replaceChildren();
    return;
  }
  const cells = (tag, texts) => {
    const tr = document.createElement('tr');
    for (const t of texts) {
      const cell = document.createElement(tag);
      cell.textContent = t;
      tr.append(cell);
    }
    return tr;
  };
  const [, ...columns] = seriesData(pubs, state.codes, state.inverted);
  const thead = document.createElement('thead');
  thead.append(cells('th', ['Day', ...state.codes.map((code) => code.toUpperCase())]));
  const tbody = document.createElement('tbody');
  for (let i = pubs.length - 1; i >= 0; i--) tbody.append(cells('td', [pubs[i].date, ...columns.map((ys) => formatRate(ys[i]))]));
  el.table.replaceChildren(thead, tbody);
}

function bindControls() {
  el.provider.addEventListener('change', () => {
    state.provider = el.provider.value;
    zoomHistory.length = 0;
    setRange(state);
  });
  for (const input of [el.from, el.to]) {
    input.addEventListener('change', () => {
      let { value: from } = el.from;
      let { value: to } = el.to;
      if (!isIsoDate(from) || !isIsoDate(to)) return; // still being typed
      // An end moved past the other one drags it along, keeping the span: the end just edited wins.
      if (from > to) {
        const span = daysBetween(state.from, state.to);
        if (input === el.from) to = addDays(from, span);
        else from = addDays(to, -span);
      }
      zoomHistory.length = 0;
      setRange({ from, to });
    });
  }
  el.presets.addEventListener('click', (e) => {
    const preset = e.target.closest('button')?.dataset.preset;
    if (!preset) return;
    const meta = metas.get(state.provider);
    zoomHistory.length = 0;
    setRange(presetRange(preset, meta.first_date, meta.last_date));
  });
  for (const radio of document.querySelectorAll('input[name="direction"]')) {
    radio.addEventListener('change', () => {
      state.inverted = radio.value === 'foreign';
      refresh();
    });
  }
  el.log.addEventListener('change', () => {
    state.log = el.log.checked;
    refresh();
  });
  el.filter.addEventListener('input', applyFilter);
  el.codes.addEventListener('change', (e) => {
    const code = e.target.value;
    hidden.delete(code);
    if (!e.target.checked) state.codes = state.codes.filter((c) => c !== code);
    else if (state.codes.length < MAX_SERIES && !state.codes.includes(code)) state.codes.push(code);
    refresh();
  });
  el.tableBox.addEventListener('toggle', renderTable);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderChart);
  new ResizeObserver(() => plot?.setSize({ width: el.chart.clientWidth, height: chartHeight() })).observe(el.chart);
}

start();
