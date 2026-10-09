import type { RunTelemetry } from "../telemetry.js";
import type { ProgressCallback } from "../progress.js";
import { createHash } from "node:crypto";
import { isObject, TWITTERAPI_BASE_URL, type FetchLike } from "./core.js";

/**
 * Upper bound on any single retry delay. A server-supplied `Retry-After` longer
 * than this is not clamped-and-retried-early — that would spend the remaining
 * attempts while the limit is still in force — the call fails visibly instead.
 */
export const MAX_RETRY_DELAY_MS = 60_000;

/** Default ceiling for the adaptive page budget (see `maxPagesCeiling`). */
export const DEFAULT_MAX_PAGES_CEILING = 20;

/** Parse `Retry-After` in either HTTP form (delta-seconds or HTTP-date). */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - nowMs);
}

function retryDelayMs(attempt: number, baseDelayMs: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) {
    // Never shorten a server-supplied delay: retrying earlier than asked just
    // spends the remaining attempts while the limit is still in force. If the
    // request is beyond what we are willing to wait, stop and say so.
    if (retryAfterMs > MAX_RETRY_DELAY_MS) {
      throw new Error(
        `twitterapi.io asked to retry in ${Math.ceil(retryAfterMs / 1_000)}s, beyond the ` +
          `${MAX_RETRY_DELAY_MS / 1_000}s cap; not retrying. Try again later or lower the request rate.`,
      );
    }
    // Floor at the backoff base so `Retry-After: 0` cannot become a hot loop.
    return Math.max(retryAfterMs, baseDelayMs);
  }
  const backoff = baseDelayMs * 2 ** attempt;
  return Math.min(backoff + Math.random() * baseDelayMs, MAX_RETRY_DELAY_MS);
}

interface AttemptResult {
  response: Response;
  body: unknown;
  /** Attempts spent to obtain this result (1 unless retries were used). */
  attempts: number;
  /** Set when the response arrived but its body could not be read. */
  bodyError?: string;
}

/**
 * Marks a transport-level failure (fetch rejection, stalled/socket error while
 * reading the body). Distinguished from a caller cancellation, a timeout, and
 * a JSON syntax error so the retry decision does not depend on message text.
 */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportError";
  }
}

/** Marks a per-request timeout. Distinct from cancellation, and retryable. */
export class TimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TimeoutError";
  }
}

/** Marks a caller cancellation. Never retried. */
export class CancelledError extends Error {
  constructor(message = "twitterapi.io search was cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** One request attempt with its own timeout; returns the parsed body alongside the response. */
async function requestOnce(
  url: string,
  apiKey: string,
  fetcher: FetchLike,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) onAbort();
  else outerSignal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // The deadline is enforced here rather than delegated to the fetcher: a
  // fetcher or body stream that ignores the signal must still not hang the call.
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(new Error("twitterapi.io request aborted"));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  aborted.catch(() => {}); // settled-after-race rejections are not unhandled errors
  try {
    const response = await Promise.race([
      fetcher(url, { headers: { "X-API-Key": apiKey }, signal: controller.signal }),
      aborted,
    ]);
    let body: unknown;
    let bodyError: string | undefined;
    try {
      body = await Promise.race([response.json(), aborted]);
    } catch (error) {
      // A stalled body trips the same abort as a stalled fetch, so distinguish
      // transport/cancellation failures from a genuine JSON syntax error.
      if (outerSignal?.aborted) throw new CancelledError();
      // The response ARRIVED; only its body stalled. This must NOT surface as a
      // retryable timeout: the page may already have been billed, so the status
      // decides what happens next rather than the retry classifier.
      if (controller.signal.aborted) {
        bodyError = `the response body did not finish within ${timeoutMs}ms`;
      } else if (!(error instanceof SyntaxError)) {
        // A JSON syntax failure means "no usable body"; any other read failure is
        // recorded for the same reason.
        bodyError = error instanceof Error ? error.message : String(error);
      }
      body = undefined;
    }
    if (controller.signal.aborted && !bodyError) {
      if (outerSignal?.aborted) throw new CancelledError();
      throw new TimeoutError(`twitterapi.io request timed out after ${timeoutMs}ms`);
    }
    return { response, body, attempts: 1, bodyError };
  } catch (error) {
    if (outerSignal?.aborted) throw new CancelledError();
    if (controller.signal.aborted) throw new TimeoutError(`twitterapi.io request timed out after ${timeoutMs}ms`);
    if (error instanceof TransportError || error instanceof TimeoutError) throw error;
    throw new TransportError(error instanceof Error ? error.message : String(error), { cause: error });
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", onAbort);
  }
}

/** Only transport failures and timeouts are retried; cancellations never are. */
function isRetryableError(error: Error): boolean {
  return error instanceof TransportError || error instanceof TimeoutError;
}

/** Backoff timer that clears itself when the caller cancels. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    // Installed before any await so an already-aborted signal settles at once.
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Abortable backoff: a cancelled tool call must not sit out the remaining delay. */
export async function sleepAbortable(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> {
  if (signal?.aborted) throw new CancelledError();
  await abortable(sleep(ms, signal), signal);
}

/**
 * The documented safe retry scope: 429 and 503 only. Retrying other statuses
 * repeats a request the upstream may already have billed, and the provider's
 * own guidance names these two. Widening this is a deliberate policy change.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * Detail text from the several error envelopes the upstream returns in the
 * wild: `{detail}` and `{msg}` for endpoint errors, and
 * `{error, message}` for account-level ones — a 402 out of credits arrives as
 * `{"error":"Unauthorized","message":"Credits is not enough.Please recharge"}`.
 * Without the last two keys, a billing failure reports only "HTTP 402".
 */
export function errorDetail(body: Record<string, unknown>): string | undefined {
  for (const key of ["detail", "msg", "message", "error"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Validate a payload that may have failed, in the order that preserves the most
 * useful error: HTTP status first (an unsuccessful response keeps its status and
 * retry context even when the body carries a semantic envelope), then an
 * unreadable body, then shape, then a semantic `status: "error"` envelope.
 */
export function ensureSuccessfulPayload(
  response: Response,
  body: unknown,
  bodyError: string | undefined,
  attempts: number,
  telemetry?: RunTelemetry,
): Record<string, unknown> {
  if (!response.ok) {
    throw new Error(describeHttpFailure(response.status, isObject(body) ? errorDetail(body) : undefined, attempts));
  }
  // A successful status whose body could not be read is NOT retried: the
  // upstream may already have billed the page, so retrying risks paying twice.
  if (bodyError) {
    throw new Error(
      `twitterapi.io returned HTTP ${response.status} but its body could not be read (${bodyError}); ` +
        "not retrying because the request may already have been billed.",
    );
  }
  if (!isObject(body)) {
    throw new Error(`twitterapi.io returned a malformed response (HTTP ${response.status})`);
  }
  // A semantic failure can also arrive with HTTP 200.
  if (body.status === "error") {
    throw new Error(`twitterapi.io error: ${errorDetail(body) ?? "unknown"}`);
  }
  telemetry?.page(body);
  return body;
}

/** Options shared by every twitterapi.io endpoint: retry, pacing, cancellation. */
export interface TwitterApiRequestOptions {
  progress?: ProgressCallback;
  telemetry?: RunTelemetry;
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Retry attempts for 429/503 responses (default 3). */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default 5_000, the unpaid-tier floor). */
  retryBaseDelayMs?: number;
  /** Shared minimum spacing between actual API dispatches in ms (default 5_000). */
  minRequestIntervalMs?: number;
  /** Injected monotonic clock for tests; use one time base per credential. */
  now?: () => number;
  /** Injected sleep, for tests. Receives the cancellation signal so a custom sleep can honor it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Caller cancellation (Pi passes the tool's AbortSignal). */
  signal?: AbortSignal;
}

/** Resolved retry/pacing settings, so each endpoint builds them identically. */
interface RequestSettings {
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  minRequestIntervalMs: number;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export function resolveRequestSettings(options: TwitterApiRequestOptions): RequestSettings {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
  return {
    timeoutMs,
    maxRetries: Math.max(0, options.maxRetries ?? 3),
    retryBaseDelayMs: Math.max(0, options.retryBaseDelayMs ?? 5_000),
    minRequestIntervalMs: Math.max(0, options.minRequestIntervalMs ?? 5_000),
    now: options.now ?? (() => performance.now()),
    sleep: options.sleep ?? defaultSleep,
    signal: options.signal,
  };
}

/** Human-readable HTTP failure that keeps the status, detail, and retry context. */
export function describeHttpFailure(status: number, detail: string | undefined, attempts: number): string {
  const lead = status === 429
    ? "rate limited"
    : status === 503
      ? "temporarily unavailable"
      : status === 402
        ? "payment required"
        : "error";
  const suffix = attempts > 1 ? ` after ${attempts} attempts` : "";
  return `twitterapi.io ${lead}${detail ? `: ${detail}` : ""} (HTTP ${status}${suffix})`;
}

interface PacerState {
  active: Set<{ interval: number }>;
  tail: Promise<void>;
  queued: number;
  lastAt?: number;
  lastInterval: number;
  now: () => number;
  cleanup?: ReturnType<typeof setTimeout>;
}

// Digest identities instead of retaining API keys in a process-lifetime map.
const credentialPacers = new Map<string, PacerState>();

/** Race even an injected sleep/queued predecessor that ignores cancellation. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(new CancelledError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

function expirePacer(key: string, state: PacerState): void {
  if (state.active.size || state.queued) return;
  clearTimeout(state.cleanup);
  const remaining = state.lastAt === undefined ? 0 : state.lastInterval - (state.now() - state.lastAt);
  if (remaining <= 0) {
    if (credentialPacers.get(key) === state) credentialPacers.delete(key);
  } else {
    state.cleanup = setTimeout(() => expirePacer(key, state), Math.min(remaining, MAX_RETRY_DELAY_MS));
    state.cleanup.unref();
  }
}

function registerPacer(url: string, apiKey: string, interval: number, now: () => number) {
  // This limiter never couples media, STT or model providers to Twitter's key.
  try { if (new URL(url).origin !== TWITTERAPI_BASE_URL) return undefined; } catch { return undefined; }
  const key = createHash("sha256").update(apiKey).digest("hex");
  let state = credentialPacers.get(key);
  if (!state) {
    state = { active: new Set(), tail: Promise.resolve(), queued: 0, lastInterval: 0, now };
    credentialPacers.set(key, state);
  }
  clearTimeout(state.cleanup);
  const caller = { interval };
  state.active.add(caller);
  return { key, state, caller };
}

/** Serialize dispatch, NOT response/body completion. Re-check time after every wake. */
async function pacedAttempt(
  registration: NonNullable<ReturnType<typeof registerPacer>>,
  now: () => number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
  dispatch: () => Promise<AttemptResult>,
): Promise<AttemptResult> {
  const { key, state } = registration;
  state.queued++;
  const grant = state.tail.then(async () => {
    try {
      for (;;) {
        if (signal?.aborted) throw new CancelledError();
        // Largest live caller interval remains in force during I/O and backoff;
        // the previous dispatch's interval also survives completion/cancellation.
        let activeInterval = 0;
        for (const active of state.active) activeInterval = Math.max(activeInterval, active.interval);
        const interval = Math.max(state.lastInterval, activeInterval);
        const at = now();
        const wait = state.lastAt === undefined ? 0 : interval - (at - state.lastAt);
        if (wait > 0) {
          await abortable(sleep(Math.min(wait, MAX_RETRY_DELAY_MS), signal), signal);
          continue;
        }
        if (signal?.aborted) throw new CancelledError();
        state.lastAt = at;
        state.lastInterval = activeInterval;
        state.now = now;
        // No await between reserving the timestamp and invoking fetch. The
        // wrapper avoids holding the FIFO lock while the billed body is read.
        const attempt = dispatch();
        // requestOnce invokes fetch synchronously before returning its promise.
        // A post-invocation timestamp conservatively covers controller/setup
        // overhead; a pre-call sample alone could make actual gaps too short.
        state.lastAt = now();
        attempt.catch(() => {}); // cancellation may win before the grant is consumed
        return { attempt };
      }
    } finally {
      state.queued--;
      expirePacer(key, state);
    }
  });
  state.tail = grant.then(() => {}, () => {}); // failed/cancelled jobs cannot poison the queue
  const { attempt } = await abortable(grant, signal);
  return attempt;
}

/** Fetch with shared per-credential attempt pacing and existing 429/503 backoff. */
export async function requestWithRetry(
  url: string,
  apiKey: string,
  fetcher: FetchLike,
  options: {
    maxRetries: number;
    retryBaseDelayMs: number;
    timeoutMs: number;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    minRequestIntervalMs?: number;
    now?: () => number;
    signal?: AbortSignal;
  },
): Promise<AttemptResult> {
  const interval = Math.max(0, options.minRequestIntervalMs ?? 5_000);
  if (!Number.isFinite(interval)) throw new Error("minRequestIntervalMs must be finite");
  if (options.signal?.aborted) throw new CancelledError();
  const now = options.now ?? (() => performance.now());
  const registration = registerPacer(url, apiKey, interval, now);
  try {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
      let result: AttemptResult;
      try {
        if (options.signal?.aborted) throw new CancelledError();
        const dispatch = () => requestOnce(url, apiKey, fetcher, options.timeoutMs, options.signal);
        result = registration
          ? await pacedAttempt(registration, now, options.sleep, options.signal, dispatch)
          : await dispatch();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (options.signal?.aborted || attempt === options.maxRetries || !isRetryableError(lastError)) {
          throw lastError;
        }
        await sleepAbortable(retryDelayMs(attempt, options.retryBaseDelayMs, undefined), options.signal, options.sleep);
        continue;
      }

      if (!isRetryableStatus(result.response.status) || attempt === options.maxRetries) {
        return { ...result, attempts: attempt + 1 };
      }
      lastError = new Error(`twitterapi.io error: HTTP ${result.response.status}`);
      const retryAfterMs = parseRetryAfter(result.response.headers?.get?.("retry-after") ?? null);
      await sleepAbortable(retryDelayMs(attempt, options.retryBaseDelayMs, retryAfterMs), options.signal, options.sleep);
    }
    throw lastError ?? new Error("twitterapi.io request failed");
  } finally {
    if (registration) {
      registration.state.active.delete(registration.caller);
      expirePacer(registration.key, registration.state);
    }
  }
}

/** Page bound shared with the configuration range, so a valid config cannot fail here. */
export const MAX_PAGE_BOUND = 100;

/**
 * Page/count bounds. An absent value takes the default; a supplied one that is
 * out of range is an error rather than a silent fallback, so a caller asking for
 * 0 pages is told instead of quietly getting the default.
 */
export function boundedCount(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`twitter ${name} must be an integer between 1 and ${max} (got ${String(value)})`);
  }
  return value;
}
