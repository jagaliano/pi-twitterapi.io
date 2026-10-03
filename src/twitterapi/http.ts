import { isObject, type FetchLike } from "./core.js";

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
  await sleep(ms, signal);
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
  return body;
}

/** Options shared by every twitterapi.io endpoint: retry, pacing, cancellation. */
export interface TwitterApiRequestOptions {
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Retry attempts for 429/503 responses (default 3). */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default 5_000, the unpaid-tier floor). */
  retryBaseDelayMs?: number;
  /** Minimum spacing between successive upstream requests in ms (default 5_000). */
  minRequestIntervalMs?: number;
  /** Injected clock, for tests. */
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
    now: options.now ?? Date.now,
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

/** Fetch with retry/backoff on 429/503 (the free tier rate-limits bursts). */
export async function requestWithRetry(
  url: string,
  apiKey: string,
  fetcher: FetchLike,
  options: {
    maxRetries: number;
    retryBaseDelayMs: number;
    timeoutMs: number;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<AttemptResult> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    let result: AttemptResult;
    try {
      result = await requestOnce(url, apiKey, fetcher, options.timeoutMs, options.signal);
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
}

/** True when retrieval stopped while the upstream still held more results. */
export const MAX_PAGE_BOUND = 100;

export function boundedCount(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`twitter ${name} must be an integer between 1 and ${max} (got ${String(value)})`);
  }
  return value;
}
