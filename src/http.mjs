// A polite HTTP client: one instance per bank, at most one request start
// every `minIntervalMs` (2 per second by default), retries with exponential
// backoff on network errors, timeouts, 429 and 5xx, and a descriptive
// User-Agent. Bodies come back as Buffers, exactly as served.

export const REPO_URL = 'https://github.com/xobotun/exchange-rates';
export const USER_AGENT =
  process.env.RATES_USER_AGENT ??
  `exchange-rates/1.0 (+${REPO_URL}; official exchange rates mirror, a few requests per day)`;

export class HttpError extends Error {
  constructor(url, status, statusText) {
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.status = status;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [opts]
 * @param {number} [opts.minIntervalMs] gap between request starts (throttle)
 * @param {number} [opts.retries] extra attempts after the first
 * @param {number} [opts.backoffMs] first retry delay; doubles each time
 * @param {number} [opts.timeoutMs] per-attempt timeout
 * @param {typeof fetch} [opts.fetchImpl] for tests
 * @param {(ms: number) => Promise<void>} [opts.sleep] for tests
 * @param {() => number} [opts.now] for tests
 */
export function createHttp({
  minIntervalMs = 500,
  retries = 4,
  backoffMs = 2000,
  timeoutMs = 60_000,
  userAgent = USER_AGENT,
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = Date.now,
  log = () => {},
} = {}) {
  let nextStartAt = 0;
  let requests = 0;

  async function throttle() {
    const wait = nextStartAt - now();
    if (wait > 0) await sleep(wait);
    nextStartAt = now() + minIntervalMs;
  }

  /**
   * @param {string} url
   * @param {{method?: string, headers?: object, body?: string, timeoutMs?: number}} [init]
   * @returns {Promise<Buffer>}
   */
  async function request(url, init = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = backoffMs * 2 ** (attempt - 1);
        log(`retry ${attempt}/${retries} in ${delay} ms: ${lastError.message}`);
        await sleep(delay);
      }
      await throttle();
      requests++;
      try {
        const res = await fetchImpl(url, {
          method: init.method ?? 'GET',
          headers: { 'User-Agent': userAgent, ...init.headers },
          body: init.body,
          redirect: 'follow',
          signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
        });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        // Drain the body so the connection can be reused.
        await res.arrayBuffer().catch(() => {});
        const error = new HttpError(url, res.status, res.statusText);
        if (res.status !== 429 && res.status < 500) throw error; // not worth retrying
        lastError = error;
      } catch (e) {
        if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
        // fetch's TypeError (DNS, reset, empty reply), AbortSignal timeouts, 429 / 5xx.
        lastError = e instanceof HttpError ? e : new Error(`${e.name}: ${e.message} (${url})`, { cause: e });
      }
    }
    throw lastError;
  }

  return {
    get: (url, init) => request(url, { ...init, method: 'GET' }),
    post: (url, init) => request(url, { ...init, method: 'POST' }),
    get requestCount() {
      return requests;
    },
  };
}
