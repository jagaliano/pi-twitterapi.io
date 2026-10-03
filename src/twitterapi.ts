/**
 * twitterapi.io backend — pure request/response logic (no pi imports).
 * Testable with an injected fetcher.
 */

export const TWITTERAPI_BASE_URL = "https://api.twitterapi.io";
export const ADVANCED_SEARCH_PATH = "/twitter/tweet/advanced_search";

export interface TwitterApiSearchParams {
  query: string;
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  queryType?: "Latest" | "Top";
  count?: number;
}

export interface NormalizedSearchParams extends TwitterApiSearchParams {
  query: string;
}

export interface TweetAuthor {
  userName?: string;
  name?: string;
  followers?: number;
}

export interface TweetMedia {
  /** "photo", "video", "animated_gif". */
  type?: string;
  /** Direct media URL. For videos this is the poster frame (a JPEG). */
  url?: string;
  /** Playable variants, highest bitrate last (videos only). */
  videoVariants?: string[];
  durationMillis?: number;
}

export interface Tweet {
  id?: string;
  url?: string;
  text?: string;
  createdAt?: string;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  viewCount?: number;
  author?: TweetAuthor;
  /** Populated from extendedEntities.media when the post carries media. */
  media?: TweetMedia[];
}

/** Why pagination stopped. Surfaced so incomplete retrieval is never presented as complete. */
export type SearchTermination = "target" | "exhausted" | "page-cap" | "cursor-cycle" | "cursor-missing";

export interface SearchDetails {
  query: string;
  expression: string;
  queryType: string;
  tweets: Tweet[];
  /** Pages actually fetched (logical requests; retries are not counted). */
  pagesFetched?: number;
  /** Present when date filters were applied — the local-day window enforced client-side. */
  window?: LocalWindow;
  /** Why pagination stopped. */
  stoppedBy?: SearchTermination;
  /**
   * Upstream posts discarded because they are NEWER than the requested local
   * window — the upstream 04:00 UTC band that sits in front of the requested
   * posts. A large count means pages (and credits) were spent reaching the day.
   */
  trimmedNewer?: number;
  /** Upstream posts discarded because they are OLDER than the window (start padding). */
  trimmedOlder?: number;
  /**
   * True when retrieval stopped while the upstream had more pages (`page-cap`
   * or `cursor-cycle`). Callers must not treat the result as complete coverage.
   */
  truncated?: boolean;
}

const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;

function normalizeHandles(handles: string[] | undefined, field: string): string[] {
  if (!handles) return [];
  if (handles.length > 20) throw new Error(`twitter ${field} accepts at most 20 handles (got ${handles.length})`);
  return handles.map((handle) => {
    const match = HANDLE_RE.exec(handle.trim());
    if (!match) throw new Error(`twitter ${field} must be valid X handles without spaces (got "${handle}")`);
    return match[1];
  });
}

function normalizeDate(date: string | undefined, field: string): string | undefined {
  if (!date) return undefined;
  const trimmed = date.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) throw new Error(`twitter ${field} must be YYYY-MM-DD (got "${date}")`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new Error(`twitter ${field} is not a real calendar date (got "${date}")`);
  }
  return trimmed;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function normalizeParams(params: TwitterApiSearchParams): NormalizedSearchParams {
  const query = params.query?.trim();
  if (!query) throw new Error("twitter query must not be empty");

  const allowed = normalizeHandles(params.allowed_x_handles, "allowed_x_handles");
  const excluded = normalizeHandles(params.excluded_x_handles, "excluded_x_handles");
  if (allowed.length > 0 && excluded.length > 0) {
    throw new Error("twitter allowed_x_handles and excluded_x_handles cannot be set together");
  }

  const fromDate = normalizeDate(params.from_date, "from_date");
  const toDate = normalizeDate(params.to_date, "to_date");
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("twitter from_date must be before or equal to to_date");
  }

  const count = params.count ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error("twitter count must be an integer between 1 and 50");
  }

  const queryType = params.queryType ?? "Latest";
  if (queryType !== "Latest" && queryType !== "Top") {
    throw new Error('twitter queryType must be "Latest" or "Top"');
  }

  return { query, allowed_x_handles: allowed, excluded_x_handles: excluded, from_date: fromDate, to_date: toDate, queryType, count };
}

/** Build the X advanced-search expression sent to twitterapi.io. */
export function buildExpression(params: NormalizedSearchParams): string {
  const constraints: string[] = [];
  if (params.allowed_x_handles?.length) {
    constraints.push(params.allowed_x_handles.length === 1
      ? `from:${params.allowed_x_handles[0]}`
      : `(${params.allowed_x_handles.map((h) => `from:${h}`).join(" OR ")})`);
  }
  if (params.excluded_x_handles?.length) {
    for (const h of params.excluded_x_handles) constraints.push(`-from:${h}`);
  }
  if (params.from_date) constraints.push(`since:${params.from_date}`);
  if (params.to_date) constraints.push(`until:${params.to_date}`);
  // Group the user query so appended AND-constraints cannot leak into
  // an OR branch (e.g. `cats OR dogs` + handle must not leave `cats` unscoped).
  if (constraints.length === 0) return params.query;
  return `(${params.query}) ${constraints.join(" ")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asMedia(raw: unknown): TweetMedia | undefined {
  if (!isObject(raw)) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const variants = isObject(raw.video_info) && Array.isArray(raw.video_info.variants) ? raw.video_info.variants : [];
  const playable = variants
    .filter((v) => isObject(v) && typeof v.url === "string" && v.content_type === "video/mp4")
    .sort((a, b) => Number((a as Record<string, unknown>).bitrate ?? 0) - Number((b as Record<string, unknown>).bitrate ?? 0))
    .map((v) => String((v as Record<string, unknown>).url));
  const duration = isObject(raw.video_info) && typeof raw.video_info.duration_millis === "number" ? raw.video_info.duration_millis : undefined;
  const media: TweetMedia = {
    type: str(raw.type),
    url: str(raw.media_url_https) ?? str(raw.media_url),
    videoVariants: playable.length > 0 ? playable : undefined,
    durationMillis: duration,
  };
  return media.url || media.videoVariants ? media : undefined;
}

function asMediaList(raw: unknown): TweetMedia[] | undefined {
  if (!isObject(raw) || !Array.isArray(raw.media)) return undefined;
  const list = raw.media.map(asMedia).filter((m): m is TweetMedia => m !== undefined);
  return list.length > 0 ? list : undefined;
}

function asTweet(raw: unknown): Tweet | undefined {
  if (!isObject(raw) || typeof raw.text !== "string") return undefined;
  const author = isObject(raw.author) ? raw.author : undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const extended = isObject(raw.extendedEntities)
    ? asMediaList(raw.extendedEntities)
    : isObject(raw.extended_entities)
      ? asMediaList(raw.extended_entities)
      : undefined;
  const media = extended ?? (isObject(raw.entities) ? asMediaList(raw.entities) : undefined);
  return {
    id: str(raw.id),
    url: str(raw.url),
    text: raw.text,
    createdAt: str(raw.createdAt),
    likeCount: num(raw.likeCount),
    retweetCount: num(raw.retweetCount),
    replyCount: num(raw.replyCount),
    viewCount: num(raw.viewCount),
    author: author ? {
      userName: str(author.userName),
      name: str(author.name),
      followers: num(author.followers),
    } : undefined,
    media,
  };
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SearchTweetsOptions {
  /** Max pages to fetch (default 5). Bounds total requests when pages come back empty. */
  maxPages?: number;
  /**
   * Hard ceiling on pages fetched in one search (default 20). `maxPages` is
   * clamped to it, so an explicit ceiling can never be exceeded.
   */
  maxPagesCeiling?: number;
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Retry attempts for 429/503 responses (default 3). */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default 5_000, the unpaid-tier floor). */
  retryBaseDelayMs?: number;
  /**
   * Minimum spacing between successive upstream requests in ms (default
   * 5_000). twitterapi.io rate-limits per API key — brand-new unpaid accounts
   * allow 0.2 QPS, i.e. one request every 5 seconds — and pagination would
   * otherwise fire requests back to back. Raise it for a higher tier, or set it
   * to 0 to disable pacing.
   */
  minRequestIntervalMs?: number;
  /** Injected clock, for tests. */
  now?: () => number;
  /** Injected sleep, for tests. Receives the cancellation signal so a custom sleep can honor it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Caller cancellation (Pi passes the tool's AbortSignal). When set, in-flight
   * requests and backoff sleeps are abandoned as soon as it aborts.
   */
  signal?: AbortSignal;
  /**
   * Fixed local UTC offset in minutes. Omit to use the host timezone, which
   * resolves each boundary with its own DST-correct offset.
   */
  localUtcOffsetMinutes?: number;
}

/**
 * twitterapi.io evaluates X `since:` / `until:` day boundaries at 04:00 UTC
 * (verified empirically: `until:2026-09-25` returned tweets up to
 * 2026-09-26T03:59:59Z, i.e. a UTC-4 day boundary rather than UTC midnight).
 * Time-of-day components (`until:2026-09-29_12:00:00_UTC`) are not honored.
 *
 * Consequences for local calendar days (offset = local - UTC):
 *  - start: the upstream bound may fall after the local one, so pad `since:`
 *    backwards by the whole days needed. Padding the start only adds older
 *    tweets to the tail of a newest-first scan, which is harmless.
 *  - end: the upstream bound may fall before the local one, leaving a gap of
 *    max(0, -offset - 4) hours at the end of the day. We deliberately do NOT
 *    pad `until:` forward: that pushes a full extra day of newer tweets ahead
 *    of the requested range and starves `count` on any busy topic (observed:
 *    0 results for a single local day).
 */
/**
 * Hour (UTC) at which twitterapi.io resolves `since:`/`until:` day boundaries.
 * Probed in September, when US Eastern is UTC-4, so a fixed 04:00Z and New York
 * local midnight are indistinguishable. Start padding therefore adds one extra
 * hour (see {@link UPSTREAM_START_PAD_HOURS}): over-padding only adds older tail
 * posts that are trimmed client-side, while under-padding would silently drop
 * the first hour of the local day if the boundary is really 05:00Z in winter.
 */
export const UPSTREAM_BOUNDARY_UTC_HOUR = 4;
/** Conservative start-padding boundary; see {@link UPSTREAM_BOUNDARY_UTC_HOUR}. */
export const UPSTREAM_START_PAD_HOURS = UPSTREAM_BOUNDARY_UTC_HOUR + 1;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

function wallClockAsUtc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d, 0, 0, 0);
}

/**
 * UTC instant at which a local calendar day begins, resolved against the host
 * timezone.
 *
 * Rather than trusting one offset probe, both plausible offsets (well before and
 * well after the boundary) are turned into candidate instants, each candidate is
 * checked for actually reading as the target local date, and the earliest valid
 * one wins. A single probe is not enough: transitions happen at local midnight in
 * some zones (America/Sao_Paulo) and at 02:00/03:00 in others
 * (Australia/Sydney, America/New_York), so any fixed probe distance is wrong for
 * one of those shapes. Validating candidates also gives the correct answers when
 * local midnight does not exist (spring forward) or happens twice (fall back).
 */
function hostLocalMidnightUtc(y: number, m: number, d: number): number {
  const wall = wallClockAsUtc(y, m, d);
  const dayIndex = Math.floor(wall / MS_PER_DAY);
  const probeOffsets = [
    new Date(wall - 12 * MS_PER_HOUR).getTimezoneOffset() * 60_000,
    new Date(wall + 12 * MS_PER_HOUR).getTimezoneOffset() * 60_000,
  ];
  const candidates = [...new Set(probeOffsets)].map((offset) => wall + offset).sort((a, b) => a - b);

  for (const candidate of candidates) {
    const localWall = candidate - new Date(candidate).getTimezoneOffset() * 60_000;
    if (Math.floor(localWall / MS_PER_DAY) === dayIndex) return candidate;
  }
  // Both candidates land on another local day: the requested day is unreachable
  // (a whole skipped day), so the earliest candidate is the closest boundary.
  return candidates[0];
}

function fixedLocalMidnightUtc(y: number, m: number, d: number, offsetMinutes: number): number {
  return wallClockAsUtc(y, m, d) - offsetMinutes * 60_000;
}

function parseDateParts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function addDaysToDate(date: string, days: number): [number, number, number] {
  const [y, m, d] = parseDateParts(date);
  const shifted = new Date(wallClockAsUtc(y, m, d) + days * MS_PER_DAY);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()];
}

/**
 * Latest upstream `since:` date whose 04:00 UTC boundary is at or before the
 * window start, so the requested window is always covered.
 */
export function upstreamStartDateString(startMs: number): string {
  return new Date(startMs - UPSTREAM_START_PAD_HOURS * MS_PER_HOUR).toISOString().slice(0, 10);
}

/** UTC instant where the upstream `until:` bound for a date stops returning posts. */
export function upstreamEndMs(toDate: string): number {
  const [y, m, d] = addDaysToDate(toDate, 1);
  return wallClockAsUtc(y, m, d) + UPSTREAM_BOUNDARY_UTC_HOUR * MS_PER_HOUR;
}

function shiftDateString(date: string, days: number): string {
  const [y, m, d] = addDaysToDate(date, days);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const X_DATE_RE = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/;
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Parse X's `Thu Oct 01 04:02:43 +0000 2026` (and ISO-8601) into epoch ms. */
export function parseTweetDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = X_DATE_RE.exec(value.trim());
  if (match) {
    const month = MONTHS[match[1]];
    if (month === undefined) return undefined;
    const [, , day, hour, minute, second, offset, year] = match;
    const sign = offset.startsWith("-") ? -1 : 1;
    const offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
    const utc = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second));
    return utc - offsetMinutes * 60_000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export interface LocalWindow {
  /** Inclusive start, epoch ms. */
  startMs: number;
  /** Exclusive end, epoch ms. */
  endMs: number;
  /** Local date requested as the start, when given. */
  fromDate?: string;
  /** Local date requested as the end, when given. */
  toDate?: string;
  /** Human-readable zone used to resolve the boundaries. */
  zone: string;
  /** Hours at the end of the window the upstream bound cannot reach (0 = full coverage). */
  shortfallHours: number;
  /**
   * Hours of *newest* upstream posts that fall after the window end and are
   * discarded client-side, because the upstream resolves date bounds at 04:00
   * UTC. Zero for any offset at or west of UTC-4; positive further east, where
   * the discarded band sits in front of the requested posts in a newest-first
   * scan.
   */
  trimHours: number;
}

/**
 * Resolve `from_date` / `to_date` (local calendar days) into a UTC window.
 * One-sided filters stay one-sided: an absent bound is left unbounded.
 * Passing an explicit `localUtcOffsetMinutes` selects fixed-offset mode;
 * otherwise each boundary uses the host's offset at that date (DST-correct).
 */
export function resolveLocalWindow(
  params: NormalizedSearchParams,
  localUtcOffsetMinutes?: number,
): LocalWindow | undefined {
  if (!params.from_date && !params.to_date) return undefined;
  const fixed = localUtcOffsetMinutes !== undefined;
  const midnight = (date: string): number => {
    const [y, m, d] = parseDateParts(date);
    return fixed
      ? fixedLocalMidnightUtc(y, m, d, localUtcOffsetMinutes)
      : hostLocalMidnightUtc(y, m, d);
  };

  const startMs = params.from_date ? midnight(params.from_date) : Number.NEGATIVE_INFINITY;
  const endMs = params.to_date ? midnight(shiftDateString(params.to_date, 1)) : Number.POSITIVE_INFINITY;

  let zone: string;
  if (fixed) {
    const sign = localUtcOffsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(localUtcOffsetMinutes);
    zone = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")} (fixed)`;
  } else {
    const reference = Number.isFinite(startMs) ? startMs : endMs;
    const offsetMinutes = -new Date(reference).getTimezoneOffset();
    const sign = offsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(offsetMinutes);
    zone = `host timezone, UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")} at window ${Number.isFinite(startMs) ? "start" : "end"}`;
  }

  const shortfallHours = params.to_date ? Math.max(0, (endMs - upstreamEndMs(params.to_date)) / MS_PER_HOUR) : 0;
  const trimHours = params.to_date ? Math.max(0, (upstreamEndMs(params.to_date) - endMs) / MS_PER_HOUR) : 0;

  return {
    startMs,
    endMs,
    fromDate: params.from_date,
    toDate: params.to_date,
    zone,
    shortfallHours,
    trimHours,
  };
}

/**
 * Pad the upstream `since:` back so the requested window start is always
 * covered. The `until:` bound is never padded forward: that would push a full
 * extra day of newer posts ahead of the range and starve `count` on busy topics.
 */
function withPaddedStart(params: NormalizedSearchParams, window: LocalWindow | undefined): NormalizedSearchParams {
  if (!params.from_date || !window || !Number.isFinite(window.startMs)) return params;
  const padded = upstreamStartDateString(window.startMs);
  return padded === params.from_date ? params : { ...params, from_date: padded };
}

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
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
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
async function sleepAbortable(
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
function ensureSuccessfulPayload(
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

function resolveRequestSettings(options: TwitterApiRequestOptions): RequestSettings {
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
async function requestWithRetry(
  url: string,
  apiKey: string,
  fetcher: FetchLike,
  options: Required<Pick<SearchTweetsOptions, "maxRetries" | "retryBaseDelayMs" | "timeoutMs">> & {
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
function isTruncated(stoppedBy: SearchTermination): boolean {
  return stoppedBy === "page-cap" || stoppedBy === "cursor-cycle" || stoppedBy === "cursor-missing";
}

/**
 * Decide the next page, or record an honest reason for stopping.
 *
 * `has_next_page !== true` genuinely means "no more results". Reporting the same
 * when upstream says there ARE more pages but hands us no cursor would present a
 * partial result as complete, so that case counts as truncation instead.
 */
function advanceOrStop(
  payload: Record<string, unknown>,
  seenCursors: Set<string>,
): { cursor: string } | SearchTermination {
  if (payload.has_next_page !== true) return "exhausted";
  if (typeof payload.next_cursor !== "string" || !payload.next_cursor) return "cursor-missing";
  if (seenCursors.has(payload.next_cursor)) return "cursor-cycle";
  seenCursors.add(payload.next_cursor);
  return { cursor: payload.next_cursor };
}

/** Run paginated advanced_search until `count` tweets or no more pages. */
export async function searchTweets(
  params: NormalizedSearchParams,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: SearchTweetsOptions = {},
): Promise<SearchDetails> {
  const window = resolveLocalWindow(params, options.localUtcOffsetMinutes);
  const requestParams = withPaddedStart(params, window);
  const expression = buildExpression(requestParams);
  const target = params.count ?? 10;
  // A ceiling is a hard cap: the base budget is clamped to it, never the other
  // way round, and non-integer or infinite values fall back to the defaults
  // rather than removing the termination bound.
  const requestedCeiling = options.maxPagesCeiling ?? DEFAULT_MAX_PAGES_CEILING;
  const pageCeiling = Number.isInteger(requestedCeiling) && requestedCeiling >= 1
    ? requestedCeiling
    : DEFAULT_MAX_PAGES_CEILING;
  const requestedBase = options.maxPages ?? 5;
  const basePageBudget = Math.min(
    Number.isInteger(requestedBase) && requestedBase >= 1 ? requestedBase : 5,
    pageCeiling,
  );
  // Free pages are granted only for posts NEWER than the window: those form the
  // upstream 04:00 UTC band sitting in front of the requested day. Older ones
  // (the start padding) sit at the tail, so paging further gains nothing.
  const trimBandHours = window?.trimHours ?? 0;
  let trimmedNewer = 0;
  let trimmedOlder = 0;
  // Pages charged to the base budget. A page spent crossing the newer band is
  // not charged — it was not answering the query — which is what stops a busy
  // topic from returning nothing. Totals stay bounded by `pageCeiling`.
  let pagesOnBudget = 0;
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 5_000);
  const minRequestIntervalMs = Math.max(0, options.minRequestIntervalMs ?? 5_000);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const collected: Tweet[] = [];
  // Keyed on both identifiers: the same post can come back with an id on one
  // page and only a permalink on another, which a single `id ?? url` key misses.
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor = "";
  let pages = 0;
  let lastRequestAt: number | undefined;
  // Only an explicit break changes this; falling out of the loop means the page
  // cap was reached, which is exactly the case that must be disclosed.
  let stoppedBy: SearchTermination = "page-cap";

  while (collected.length < target && pagesOnBudget < basePageBudget && pages < pageCeiling) {
    if (signal?.aborted) throw new CancelledError();
    // Pace successive requests: the per-key QPS ceiling is low enough (0.2 QPS
    // on an unpaid account) that unpaced pagination can rate-limit itself.
    if (minRequestIntervalMs > 0 && lastRequestAt !== undefined) {
      const wait = minRequestIntervalMs - (now() - lastRequestAt);
      if (wait > 0) await sleepAbortable(wait, signal, sleep);
    }
    pages += 1;
    let url: URL;
    try {
      url = new URL(TWITTERAPI_BASE_URL + ADVANCED_SEARCH_PATH);
    } catch {
      throw new Error("twitterapi.io: invalid search URL (internal error)");
    }
    url.searchParams.set("query", expression);
    url.searchParams.set("queryType", params.queryType ?? "Latest");
    if (cursor) url.searchParams.set("cursor", cursor);

    const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, {
      maxRetries,
      retryBaseDelayMs,
      timeoutMs,
      sleep,
      signal,
    });
    lastRequestAt = now();

    // Errors are validated in one place, in the order that preserves the most
    // useful signal: status, then unreadable body, then shape, then semantics.
    const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
    if (!Array.isArray(payload.tweets)) {
      throw new Error("twitterapi.io returned a malformed response (missing tweets array)");
    }

    let pageTrimmedNewer = 0;
    for (const raw of payload.tweets) {
      const tweet = asTweet(raw);
      if (!tweet) continue;
      // Enforce the caller's real local day range: the upstream window may be
      // padded at the start and stops short at the end. Unparseable dates are
      // kept (fail-open).
      if (window) {
        const at = parseTweetDate(tweet.createdAt);
        if (at !== undefined) {
          if (at >= window.endMs) {
            pageTrimmedNewer += 1;
            trimmedNewer += 1;
            continue;
          }
          if (at < window.startMs) {
            trimmedOlder += 1;
            continue;
          }
        }
      }
      // Register both identifiers even when this occurrence is itself a
      // duplicate: otherwise an alias chain ((id=1,url=A), (id=1,url=B),
      // (no id,url=B)) lets the third representation through as a new post.
      const duplicate =
        (tweet.id !== undefined && seenIds.has(tweet.id)) ||
        (tweet.url !== undefined && seenUrls.has(tweet.url));
      if (tweet.id) seenIds.add(tweet.id);
      if (tweet.url) seenUrls.add(tweet.url);
      if (duplicate) continue;
      collected.push(tweet);
      if (collected.length >= target) break;
    }

    // Only pages spent crossing the newer band are free. A page that merely ran
    // past the end of the window (older start-padding posts) is charged, since
    // nothing further ahead can be in-window.
    if (trimBandHours === 0 || pageTrimmedNewer === 0) pagesOnBudget += 1;

    const step = advanceOrStop(payload, seenCursors);
    if (typeof step === "string") {
      stoppedBy = step;
      break;
    }
    cursor = step.cursor;
  }
  if (collected.length >= target) stoppedBy = "target";

  return {
    query: params.query,
    expression,
    queryType: params.queryType ?? "Latest",
    tweets: collected,
    pagesFetched: pages,
    window,
    stoppedBy,
    truncated: isTruncated(stoppedBy),
    trimmedNewer: trimmedNewer > 0 ? trimmedNewer : undefined,
    trimmedOlder: trimmedOlder > 0 ? trimmedOlder : undefined,
  };
}

/**
 * Status id from an X/Twitter permalink.
 *
 * Only validated x.com / twitter.com hosts are considered, and the id must be a
 * whole path segment, so `https://x.com/search?q=/status/111` and
 * `.../status/111garbage` cannot masquerade as a real post. Real suffixes such
 * as `/photo/1` still resolve. This is the single X-URL parser for the package:
 * `synthesize.ts` re-exports it for citation matching.
 */
export function statusIdFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const isX = host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
  if (!isX) return undefined;
  const match = /\/status(?:es)?\/(\d+)(?:\/|$)/.exec(parsed.pathname);
  return match?.[1];
}

/**
 * Accept either a bare post id or an X permalink and return the id.
 * Rejects anything else so a malformed reference fails before the request.
 */
export function tweetIdFromInput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d{1,25}$/.test(trimmed)) return trimmed;
  return statusIdFromUrl(trimmed);
}

// --------------------------------------------------------------------- users

/**
 * An X account from `/twitter/user/search`.
 *
 * The published schema does not match the live response: the handle is
 * `screen_name` (the documented `userName` is absent and `username` is null),
 * the counts are `followers_count` / `following_count`, and `url` is a **t.co
 * redirect** rather than the profile link the docs promise. So `profileUrl` is
 * constructed, and an account without a handle is dropped instead of being
 * published with an unusable link.
 */
export interface UserProfile {
  id?: string;
  /** Handle without "@". */
  handle: string;
  name?: string;
  bio?: string;
  followers?: number;
  following?: number;
  verified?: boolean;
  /** Always constructed: `https://x.com/<handle>`. */
  profileUrl: string;
  location?: string;
  createdAt?: string;
}

function asUser(raw: unknown): UserProfile | undefined {
  if (!isObject(raw)) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const handle = str(raw.screen_name) ?? str(raw.userName) ?? str(raw.username);
  if (!handle) return undefined;
  return {
    id: str(raw.id),
    handle,
    name: str(raw.name),
    bio: str(raw.description) ?? (isObject(raw.profile_bio) ? str(raw.profile_bio.description) : undefined),
    followers: num(raw.followers_count) ?? num(raw.followers),
    following: num(raw.following_count) ?? num(raw.following),
    verified: raw.isBlueVerified === true || raw.verified === true,
    profileUrl: `https://x.com/${handle}`,
    location: str(raw.location),
    createdAt: str(raw.created_at) ?? str(raw.createdAt),
  };
}

/**
 * Page/count bounds. An absent value takes the default; a supplied one that is
 * out of range is an error rather than a silent fallback, so a caller asking for
 * 0 pages is told instead of quietly getting the default.
 */
/** Page bound shared with the configuration range, so a valid config cannot fail here. */
export const MAX_PAGE_BOUND = 100;

function boundedCount(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`twitter ${name} must be an integer between 1 and ${max} (got ${String(value)})`);
  }
  return value;
}

export const USER_SEARCH_PATH = "/twitter/user/search";
export const THREAD_CONTEXT_PATH = "/twitter/tweet/thread_context";

export interface UserSearchDetails {
  query: string;
  users: UserProfile[];
  pagesFetched: number;
  /** Why pagination stopped. */
  stoppedBy: SearchTermination;
  /** True when accounts remained upstream (`page-cap` or `cursor-cycle`). */
  truncated: boolean;
}

export interface SearchUsersOptions extends TwitterApiRequestOptions {
  /** Max pages to fetch (default 3). Each page holds up to 20 accounts. */
  maxPages?: number;
  /** Max accounts to collect (default 20, max 50). */
  count?: number;
}

/** Search X accounts by keyword via `/twitter/user/search`. */
export async function searchUsers(
  query: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: SearchUsersOptions = {},
): Promise<UserSearchDetails> {
  const trimmed = query?.trim();
  if (!trimmed) throw new Error("twitter query must not be empty");
  const settings = resolveRequestSettings(options);
  const maxPages = boundedCount(options.maxPages, 3, MAX_PAGE_BOUND, "maxPages");
  const target = boundedCount(options.count, 20, 50, "count");
  const collected: UserProfile[] = [];
  // Both identifiers, like the post path: an account can come back with an id on
  // one page and only a handle (or a different case) on another.
  const seenIds = new Set<string>();
  const seenHandles = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor = "";
  let pages = 0;
  let lastRequestAt: number | undefined;
  let stoppedBy: SearchTermination = "page-cap";

  while (collected.length < target && pages < maxPages) {
    if (settings.signal?.aborted) throw new CancelledError();
    if (settings.minRequestIntervalMs > 0 && lastRequestAt !== undefined) {
      const wait = settings.minRequestIntervalMs - (settings.now() - lastRequestAt);
      if (wait > 0) await sleepAbortable(wait, settings.signal, settings.sleep);
    }
    pages += 1;
    const url = new URL(TWITTERAPI_BASE_URL + USER_SEARCH_PATH);
    url.searchParams.set("query", trimmed);
    if (cursor) url.searchParams.set("cursor", cursor);

    const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, settings);
    lastRequestAt = settings.now();
    const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
    if (!Array.isArray(payload.users)) {
      throw new Error("twitterapi.io returned a malformed response (missing users array)");
    }

    for (const raw of payload.users) {
      const user = asUser(raw);
      if (!user) continue;
      // Register both identifiers even when this occurrence is itself a
      // duplicate, so an alias chain cannot let a third form through.
      const handleKey = user.handle.toLowerCase();
      const duplicate = (user.id !== undefined && seenIds.has(user.id)) || seenHandles.has(handleKey);
      if (user.id) seenIds.add(user.id);
      seenHandles.add(handleKey);
      if (duplicate) continue;
      collected.push(user);
      if (collected.length >= target) break;
    }

    const step = advanceOrStop(payload, seenCursors);
    if (typeof step === "string") {
      stoppedBy = step;
      break;
    }
    cursor = step.cursor;
  }

  if (collected.length >= target) stoppedBy = "target";
  return {
    query: trimmed,
    users: collected,
    pagesFetched: pages,
    stoppedBy,
    truncated: isTruncated(stoppedBy),
  };
}

// -------------------------------------------------------------------- thread

export interface ThreadDetails {
  tweetId: string;
  tweets: Tweet[];
  pagesFetched: number;
  /** Why pagination stopped. */
  stoppedBy: SearchTermination;
  /** True when the thread continued upstream (`page-cap` or `cursor-cycle`). */
  truncated: boolean;
}

export interface FetchThreadOptions extends TwitterApiRequestOptions {
  /**
   * Max pages of thread context (default 4). The upstream page size is not
   * settable and is not fixed, so this bounds requests rather than posts.
   */
  maxPages?: number;
}

/**
 * Fetch a post's thread context (the root post plus its replies).
 */
export async function fetchThread(
  tweetId: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: FetchThreadOptions = {},
): Promise<ThreadDetails> {
  const id = tweetIdFromInput(tweetId);
  if (!id) throw new Error(`twitter tweet must be a numeric post id or an X permalink (got "${tweetId}")`);
  const settings = resolveRequestSettings(options);
  const maxPages = boundedCount(options.maxPages, 4, MAX_PAGE_BOUND, "maxPages");
  const collected: Tweet[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor = "";
  let pages = 0;
  let lastRequestAt: number | undefined;
  let stoppedBy: SearchTermination = "page-cap";

  while (pages < maxPages) {
    if (settings.signal?.aborted) throw new CancelledError();
    if (settings.minRequestIntervalMs > 0 && lastRequestAt !== undefined) {
      const wait = settings.minRequestIntervalMs - (settings.now() - lastRequestAt);
      if (wait > 0) await sleepAbortable(wait, settings.signal, settings.sleep);
    }
    pages += 1;
    const url = new URL(TWITTERAPI_BASE_URL + THREAD_CONTEXT_PATH);
    url.searchParams.set("tweetId", id);
    if (cursor) url.searchParams.set("cursor", cursor);

    const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, settings);
    lastRequestAt = settings.now();
    const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
    if (!Array.isArray(payload.tweets)) {
      throw new Error("twitterapi.io returned a malformed response (missing tweets array)");
    }

    for (const raw of payload.tweets) {
      const tweet = asTweet(raw);
      if (!tweet) continue;
      const duplicate =
        (tweet.id !== undefined && seenIds.has(tweet.id)) ||
        (tweet.url !== undefined && seenUrls.has(tweet.url));
      if (tweet.id) seenIds.add(tweet.id);
      if (tweet.url) seenUrls.add(tweet.url);
      if (duplicate) continue;
      collected.push(tweet);
    }

    // A genuinely EMPTY page means the walk is over: upstream warns that
    // `has_next_page` can be true with no further data. A page that merely
    // repeated posts we already hold is different — pagination overlap is
    // normal, and stopping there would drop later posts while claiming the
    // thread was fully read. Duplicate-only pages therefore continue under the
    // page bounds, and running out of pages is reported as truncation.
    if (payload.tweets.length === 0) {
      stoppedBy = "exhausted";
      break;
    }
    const step = advanceOrStop(payload, seenCursors);
    if (typeof step === "string") {
      stoppedBy = step;
      break;
    }
    cursor = step.cursor;
  }

  return {
    tweetId: id,
    tweets: collected,
    pagesFetched: pages,
    stoppedBy,
    truncated: isTruncated(stoppedBy),
  };
}

// ----------------------------------------------------- generic tweet paging

/** Options shared by the read endpoints that walk `{ tweets, has_next_page, next_cursor }`. */
export interface TweetPagingOptions extends TwitterApiRequestOptions {
  /** Base page budget (default 3). Each page holds up to ~20 posts. */
  maxPages?: number;
  /** Hard ceiling the base budget is clamped to (default 20). */
  maxPagesCeiling?: number;
  /** Stop once this many unique posts are collected. */
  limit?: number;
}

export interface TweetCollection {
  tweets: Tweet[];
  pagesFetched: number;
  stoppedBy: SearchTermination;
  /** True when posts remained upstream (`page-cap` or `cursor-cycle`). */
  truncated: boolean;
}

/**
 * Cursor-paginate any endpoint returning `{ tweets, has_next_page, next_cursor }`.
 *
 * Shared by the account, reply, quote and mention reads. It keeps the same
 * honesty rules as the search path: pacing between requests, retries on 429/503,
 * duplicate suppression, and an explicit reason when the walk stopped short of
 * exhausting the upstream.
 */
async function walkTweets(
  path: string,
  apiKey: string,
  fetcher: FetchLike,
  options: TweetPagingOptions & {
    params?: Record<string, string | number | boolean | undefined>;
    /** Where this endpoint puts its tweet array; defaults to the top level. */
    extract?: (payload: Record<string, unknown>) => unknown[] | undefined;
  },
): Promise<TweetCollection> {
  const settings = resolveRequestSettings(options);
  const ceiling = boundedCount(options.maxPagesCeiling, DEFAULT_MAX_PAGES_CEILING, MAX_PAGE_BOUND, "maxPagesCeiling");
  const maxPages = Math.min(boundedCount(options.maxPages, 3, MAX_PAGE_BOUND, "maxPages"), ceiling);
  const limit = options.limit === undefined ? undefined : boundedCount(options.limit, 20, 1_000, "limit");
  const collected: Tweet[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor = "";
  let pages = 0;
  let lastRequestAt: number | undefined;
  let stoppedBy: SearchTermination = "page-cap";

  while (pages < maxPages && (limit === undefined || collected.length < limit)) {
    if (settings.signal?.aborted) throw new CancelledError();
    if (settings.minRequestIntervalMs > 0 && lastRequestAt !== undefined) {
      const wait = settings.minRequestIntervalMs - (settings.now() - lastRequestAt);
      if (wait > 0) await sleepAbortable(wait, settings.signal, settings.sleep);
    }
    pages += 1;
    const url = new URL(TWITTERAPI_BASE_URL + path);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    if (cursor) url.searchParams.set("cursor", cursor);

    const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, settings);
    lastRequestAt = settings.now();
    const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
    const rawTweets = options.extract ? options.extract(payload) : payload.tweets;
    if (!Array.isArray(rawTweets)) {
      throw new Error("twitterapi.io returned a malformed response (missing tweets array)");
    }

    for (const raw of rawTweets) {
      const tweet = asTweet(raw);
      if (!tweet) continue;
      const duplicate =
        (tweet.id !== undefined && seenIds.has(tweet.id)) ||
        (tweet.url !== undefined && seenUrls.has(tweet.url));
      if (tweet.id) seenIds.add(tweet.id);
      if (tweet.url) seenUrls.add(tweet.url);
      if (duplicate) continue;
      collected.push(tweet);
      if (limit !== undefined && collected.length >= limit) break;
    }

    const step = advanceOrStop(payload, seenCursors);
    if (typeof step === "string") {
      stoppedBy = step;
      break;
    }
    cursor = step.cursor;
  }
  if (limit !== undefined && collected.length >= limit) stoppedBy = "target";

  return { tweets: collected, pagesFetched: pages, stoppedBy, truncated: isTruncated(stoppedBy) };
}

// -------------------------------------------------- account timeline (P1)

export const USER_LAST_TWEETS_PATH = "/twitter/user/last_tweets";
export const TWEET_REPLIES_PATH = "/twitter/tweet/replies/v2";
export const TWEET_QUOTES_PATH = "/twitter/tweet/quotes";
export const TRENDS_PATH = "/twitter/trends";

export interface UserTweetsDetails extends TweetCollection {
  userName?: string;
  userId?: string;
}

export interface FetchUserTweetsOptions extends TweetPagingOptions {
  /** Include the account's replies in addition to top-level posts. */
  includeReplies?: boolean;
}

/** Fetch an account's most recent posts via `/twitter/user/last_tweets`. */
export async function fetchUserTweets(
  ref: { userName?: string; userId?: string },
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: FetchUserTweetsOptions = {},
): Promise<UserTweetsDetails> {
  const userName = ref.userName?.trim().replace(/^@+/, "");
  const userId = ref.userId?.trim();
  if (!userName && !userId) throw new Error('twitter mode "user" needs a userName or userId');
  const { includeReplies, ...paging } = options;
  const result = await walkTweets(USER_LAST_TWEETS_PATH, apiKey, fetcher, {
    ...paging,
    params: { userName, userId, includeReplies: includeReplies === true ? "true" : undefined },
    // `/twitter/user/last_tweets` returns `{ data: { tweets, pin_tweet } }`,
    // unlike the other reads that put `tweets` at the top level.
    extract: (payload) => {
      const data = payload.data;
      if (typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).tweets)) {
        return (data as Record<string, unknown>).tweets as unknown[];
      }
      return Array.isArray(payload.tweets) ? payload.tweets : undefined;
    },
  });
  return { ...result, userName, userId };
}

// ------------------------------------------------------- replies (P1)

export type ReplySort = "Relevance" | "Latest" | "Likes";

export interface TweetRepliesDetails extends TweetCollection {
  tweetId: string;
}

export interface FetchTweetRepliesOptions extends TweetPagingOptions {
  /** Sort order for replies (default Relevance). */
  queryType?: ReplySort;
}

/** Fetch replies to a post via `/twitter/tweet/replies/v2`. */
export async function fetchTweetReplies(
  tweet: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: FetchTweetRepliesOptions = {},
): Promise<TweetRepliesDetails> {
  const id = tweetIdFromInput(tweet);
  if (!id) throw new Error(`twitter tweet must be a numeric post id or an X permalink (got "${tweet}")`);
  const { queryType, ...paging } = options;
  if (queryType !== undefined && queryType !== "Relevance" && queryType !== "Latest" && queryType !== "Likes") {
    throw new Error(`twitter reply queryType must be "Relevance", "Latest" or "Likes" (got "${queryType}")`);
  }
  const result = await walkTweets(TWEET_REPLIES_PATH, apiKey, fetcher, {
    ...paging,
    params: { tweetId: id, queryType },
  });
  return { ...result, tweetId: id };
}

// -------------------------------------------------------- quotes (P1)

export interface TweetQuotesDetails extends TweetCollection {
  tweetId: string;
}

export interface FetchTweetQuotesOptions extends TweetPagingOptions {
  /** Only quotes on or after this unix timestamp (seconds). */
  sinceTime?: number;
  /** Only quotes before this unix timestamp (seconds). */
  untilTime?: number;
  /** Include replies among the quotes (upstream default true). */
  includeReplies?: boolean;
}

/** Fetch quote-posts of a post via `/twitter/tweet/quotes`. */
export async function fetchTweetQuotes(
  tweet: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: FetchTweetQuotesOptions = {},
): Promise<TweetQuotesDetails> {
  const id = tweetIdFromInput(tweet);
  if (!id) throw new Error(`twitter tweet must be a numeric post id or an X permalink (got "${tweet}")`);
  const { sinceTime, untilTime, includeReplies, ...paging } = options;
  for (const [name, value] of [["sinceTime", sinceTime], ["untilTime", untilTime]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`twitter ${name} must be a non-negative unix timestamp in seconds`);
    }
  }
  if (sinceTime !== undefined && untilTime !== undefined && sinceTime > untilTime) {
    throw new Error("twitter sinceTime must be before or equal to untilTime");
  }
  const result = await walkTweets(TWEET_QUOTES_PATH, apiKey, fetcher, {
    ...paging,
    params: {
      tweetId: id,
      sinceTime,
      untilTime,
      includeReplies: includeReplies === undefined ? undefined : includeReplies ? "true" : "false",
    },
  });
  return { ...result, tweetId: id };
}

// -------------------------------------------------------- trends (P1)

export interface Trend {
  name: string;
  rank?: number;
  /** The search expression X uses for this trend (e.g. `#elonmusk`). */
  query?: string;
  /** Human-readable volume hint such as "17.7K posts" when upstream provides it. */
  metaDescription?: string;
}

export interface TrendsDetails {
  woeid: number;
  trends: Trend[];
}

function asTrend(raw: unknown): Trend | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const outer = raw as Record<string, unknown>;
  // Upstream wraps each item as `{ trend: { name, target, rank } }`; a flat item
  // is also accepted so a shape change does not silently drop every trend.
  const record =
    typeof outer.trend === "object" && outer.trend !== null
      ? (outer.trend as Record<string, unknown>)
      : outer;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return undefined;
  const target = record.target;
  const query =
    typeof target === "object" && target !== null && typeof (target as Record<string, unknown>).query === "string"
      ? ((target as Record<string, unknown>).query as string).trim()
      : undefined;
  const trend: Trend = { name };
  if (typeof record.rank === "number") trend.rank = record.rank;
  if (query) trend.query = query;
  const metaDescription =
    typeof record.meta_description === "string" ? record.meta_description : outer.meta_description;
  if (typeof metaDescription === "string" && metaDescription.trim()) {
    trend.metaDescription = metaDescription.trim();
  }
  return trend;
}

export interface FetchTrendsOptions extends TwitterApiRequestOptions {
  /** Number of trends to return. Upstream default 30; minimum 30. */
  count?: number;
}

/** Fetch trending topics for a location via `/twitter/trends`. */
export async function fetchTrends(
  woeid: number,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: FetchTrendsOptions = {},
): Promise<TrendsDetails> {
  if (!Number.isInteger(woeid)) throw new Error(`twitter woeid must be an integer (got ${String(woeid)})`);
  const settings = resolveRequestSettings(options);
  const url = new URL(TWITTERAPI_BASE_URL + TRENDS_PATH);
  url.searchParams.set("woeid", String(woeid));
  if (options.count !== undefined) {
    if (!Number.isInteger(options.count) || options.count < 30) {
      throw new Error("twitter trend count must be an integer >= 30");
    }
    url.searchParams.set("count", String(options.count));
  }
  const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, settings);
  const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
  if (!Array.isArray(payload.trends)) {
    throw new Error("twitterapi.io returned a malformed response (missing trends array)");
  }
  const trends: Trend[] = [];
  const seen = new Set<string>();
  for (const raw of payload.trends) {
    const trend = asTrend(raw);
    if (!trend) continue;
    const key = trend.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    trends.push(trend);
  }
  return { woeid, trends };
}

// -------------------------------------------- accounts & lookups (P2)

export const USER_MENTIONS_PATH = "/twitter/user/mentions";
export const USER_FOLLOWERS_PATH = "/twitter/user/followers";
export const USER_FOLLOWINGS_PATH = "/twitter/user/followings";
export const USER_INFO_PATH = "/twitter/user/info";
export const TWEETS_BY_IDS_PATH = "/twitter/tweets";

export interface UserCollection {
  users: UserProfile[];
  pagesFetched: number;
  stoppedBy: SearchTermination;
  /** True when accounts remained upstream (`page-cap` or `cursor-cycle`). */
  truncated: boolean;
}

/** Cursor-paginate an endpoint that returns an account array under `arrayKey`. */
async function walkUsers(
  path: string,
  apiKey: string,
  fetcher: FetchLike,
  options: TweetPagingOptions & {
    arrayKey: string;
    params?: Record<string, string | number | boolean | undefined>;
  },
): Promise<UserCollection> {
  const settings = resolveRequestSettings(options);
  const ceiling = boundedCount(options.maxPagesCeiling, DEFAULT_MAX_PAGES_CEILING, MAX_PAGE_BOUND, "maxPagesCeiling");
  const maxPages = Math.min(boundedCount(options.maxPages, 3, MAX_PAGE_BOUND, "maxPages"), ceiling);
  const limit = options.limit === undefined ? undefined : boundedCount(options.limit, 20, 1_000, "limit");
  const collected: UserProfile[] = [];
  const seenIds = new Set<string>();
  const seenHandles = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor = "";
  let pages = 0;
  let lastRequestAt: number | undefined;
  let stoppedBy: SearchTermination = "page-cap";

  while (pages < maxPages && (limit === undefined || collected.length < limit)) {
    if (settings.signal?.aborted) throw new CancelledError();
    if (settings.minRequestIntervalMs > 0 && lastRequestAt !== undefined) {
      const wait = settings.minRequestIntervalMs - (settings.now() - lastRequestAt);
      if (wait > 0) await sleepAbortable(wait, settings.signal, settings.sleep);
    }
    pages += 1;
    const url = new URL(TWITTERAPI_BASE_URL + path);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    if (cursor) url.searchParams.set("cursor", cursor);

    const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, settings);
    lastRequestAt = settings.now();
    const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
    if (!Array.isArray(payload[options.arrayKey])) {
      throw new Error(`twitterapi.io returned a malformed response (missing ${options.arrayKey} array)`);
    }

    for (const raw of payload[options.arrayKey] as unknown[]) {
      const user = asUser(raw);
      if (!user) continue;
      const handleKey = user.handle.toLowerCase();
      const duplicate = (user.id !== undefined && seenIds.has(user.id)) || seenHandles.has(handleKey);
      if (user.id) seenIds.add(user.id);
      seenHandles.add(handleKey);
      if (duplicate) continue;
      collected.push(user);
      if (limit !== undefined && collected.length >= limit) break;
    }

    const step = advanceOrStop(payload, seenCursors);
    if (typeof step === "string") {
      stoppedBy = step;
      break;
    }
    cursor = step.cursor;
  }
  if (limit !== undefined && collected.length >= limit) stoppedBy = "target";

  return { users: collected, pagesFetched: pages, stoppedBy, truncated: isTruncated(stoppedBy) };
}

/** Validate an optional unix-seconds bound. */
function unixSeconds(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`twitter ${name} must be a non-negative unix timestamp in seconds`);
  }
}

function requireUserName(userName: string | undefined, mode: string): string {
  const handle = userName?.trim().replace(/^@+/, "");
  if (!handle) throw new Error(`twitter mode "${mode}" needs a userName`);
  return handle;
}

export interface UserMentionsDetails extends TweetCollection {
  userName: string;
}

export interface FetchUserMentionsOptions extends TweetPagingOptions {
  sinceTime?: number;
  untilTime?: number;
}

/** Fetch posts that mention an account via `/twitter/user/mentions`. */
export async function fetchUserMentions(
  userName: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: FetchUserMentionsOptions = {},
): Promise<UserMentionsDetails> {
  const handle = requireUserName(userName, "mentions");
  const { sinceTime, untilTime, ...paging } = options;
  unixSeconds(sinceTime, "sinceTime");
  unixSeconds(untilTime, "untilTime");
  if (sinceTime !== undefined && untilTime !== undefined && sinceTime > untilTime) {
    throw new Error("twitter sinceTime must be before or equal to untilTime");
  }
  const result = await walkTweets(USER_MENTIONS_PATH, apiKey, fetcher, {
    ...paging,
    params: { userName: handle, sinceTime, untilTime },
  });
  return { ...result, userName: handle };
}

export interface FollowersDetails extends UserCollection {
  userName: string;
}

export interface FetchFollowOptions extends TweetPagingOptions {
  /** Accounts per page, upstream accepts 20–200. */
  pageSize?: number;
}

function followOptions(
  handle: string,
  options: FetchFollowOptions,
): TweetPagingOptions & { params: Record<string, string | number | undefined> } {
  const { pageSize, ...paging } = options;
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 20 || pageSize > 200)) {
    throw new Error("twitter pageSize must be an integer between 20 and 200");
  }
  return { ...paging, params: { userName: handle, pageSize } };
}

/** Fetch an account's followers via `/twitter/user/followers`. */
export async function fetchFollowers(
  userName: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: FetchFollowOptions = {},
): Promise<FollowersDetails> {
  const handle = requireUserName(userName, "followers");
  const result = await walkUsers(USER_FOLLOWERS_PATH, apiKey, fetcher, {
    ...followOptions(handle, options),
    arrayKey: "followers",
  });
  return { ...result, userName: handle };
}

/** Fetch the accounts an account follows via `/twitter/user/followings`. */
export async function fetchFollowings(
  userName: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: FetchFollowOptions = {},
): Promise<FollowersDetails> {
  const handle = requireUserName(userName, "followings");
  const result = await walkUsers(USER_FOLLOWINGS_PATH, apiKey, fetcher, {
    ...followOptions(handle, options),
    arrayKey: "followings",
  });
  return { ...result, userName: handle };
}

/** Fetch a single profile via `/twitter/user/info`. */
export async function fetchUserProfile(
  userName: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: TwitterApiRequestOptions = {},
): Promise<UserProfile> {
  const handle = requireUserName(userName, "profile");
  const settings = resolveRequestSettings(options);
  const url = new URL(TWITTERAPI_BASE_URL + USER_INFO_PATH);
  url.searchParams.set("userName", handle);
  const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, settings);
  const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
  const user = asUser(payload.data);
  if (!user) throw new Error(`twitterapi.io returned no profile for "${handle}"`);
  return user;
}

/** Fetch specific posts by id via `/twitter/tweets` (max 100 ids). */
export async function fetchTweetsByIds(
  ids: readonly string[],
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: TwitterApiRequestOptions = {},
): Promise<TweetCollection> {
  // The tool accepts ids or permalinks, so every entry is canonicalised to a
  // post id before the paid endpoint is called; an unusable reference is
  // rejected rather than sent upstream.
  const cleaned: string[] = [];
  const requested = new Set<string>();
  for (const raw of ids) {
    const id = tweetIdFromInput(raw);
    if (!id) throw new Error(`twitter mode "tweets" needs numeric post ids or X permalinks (got "${raw}")`);
    if (requested.has(id)) continue;
    requested.add(id);
    cleaned.push(id);
  }
  if (cleaned.length === 0) throw new Error("twitter mode \"tweets\" needs at least one id in `ids`");
  if (cleaned.length > 100) throw new Error("twitter mode \"tweets\" accepts at most 100 ids");
  const settings = resolveRequestSettings(options);
  const url = new URL(TWITTERAPI_BASE_URL + TWEETS_BY_IDS_PATH);
  url.searchParams.set("tweet_ids", cleaned.join(","));
  const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, settings);
  const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
  if (!Array.isArray(payload.tweets)) {
    throw new Error("twitterapi.io returned a malformed response (missing tweets array)");
  }
  const tweets: Tweet[] = [];
  // Register both identifiers, like the paginated walkers: a post returned with
  // an id and again with only its permalink is the same post.
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  for (const raw of payload.tweets) {
    const tweet = asTweet(raw);
    if (!tweet) continue;
    const duplicate =
      (tweet.id !== undefined && seenIds.has(tweet.id)) ||
      (tweet.url !== undefined && seenUrls.has(tweet.url));
    if (tweet.id) seenIds.add(tweet.id);
    if (tweet.url) seenUrls.add(tweet.url);
    if (duplicate) continue;
    tweets.push(tweet);
  }
  return { tweets, pagesFetched: 1, stoppedBy: "exhausted", truncated: false };
}

// --------------------------------------- communities, lists, spaces (P3)

export const COMMUNITY_TWEETS_PATH = "/twitter/community/tweets";
export const LIST_TWEETS_PATH = "/twitter/list/tweets_timeline";
export const SPACE_DETAIL_PATH = "/twitter/spaces/detail";

/** Fetch posts from a community via `/twitter/community/tweets`. */
export async function fetchCommunityTweets(
  communityId: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: TweetPagingOptions = {},
): Promise<TweetCollection> {
  const id = communityId?.trim();
  if (!id) throw new Error('twitter mode "community" needs a communityId');
  return walkTweets(COMMUNITY_TWEETS_PATH, apiKey, fetcher, { ...options, params: { community_id: id } });
}

/** Fetch posts from a list via `/twitter/list/tweets_timeline`. */
export async function fetchListTweets(
  listId: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: TweetPagingOptions = {},
): Promise<TweetCollection> {
  const id = listId?.trim();
  if (!id) throw new Error('twitter mode "list" needs a listId');
  return walkTweets(LIST_TWEETS_PATH, apiKey, fetcher, { ...options, params: { listId: id } });
}

/** A Space's detail payload (`/twitter/spaces/detail` nests it under `data`). */
export interface SpaceDetails {
  id: string;
  data: Record<string, unknown>;
}

/** Fetch an X Space's detail via `/twitter/spaces/detail`. */
export async function fetchSpaceDetail(
  spaceId: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: TwitterApiRequestOptions = {},
): Promise<SpaceDetails> {
  const id = spaceId?.trim();
  if (!id) throw new Error('twitter mode "space" needs a spaceId');
  const settings = resolveRequestSettings(options);
  const url = new URL(TWITTERAPI_BASE_URL + SPACE_DETAIL_PATH);
  url.searchParams.set("space_id", id);
  const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, settings);
  const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
  // Live responses nest the object under `detail` (the docs say `data`), and use
  // a string there to report "not found". Accept both envelopes.
  const raw = payload.detail ?? payload.data;
  if (typeof raw === "string" && raw.trim()) {
    throw new Error(`twitterapi.io space lookup failed: ${raw.trim()}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("twitterapi.io returned no space detail");
  }
  return { id, data: raw as Record<string, unknown> };
}
