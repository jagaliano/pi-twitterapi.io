import {
  ADVANCED_SEARCH_PATH,
  TWITTERAPI_BASE_URL,
  type FetchLike,
  type NormalizedSearchParams,
  type SearchDetails,
  type SearchTermination,
  type Tweet,
} from "./core.js";
import { buildExpression } from "./params.js";
import { parseTweetDate, resolveLocalWindow, withPaddedStart } from "./window.js";
import {
  CancelledError,
  DEFAULT_MAX_PAGES_CEILING,
  defaultSleep,
  ensureSuccessfulPayload,
  requestWithRetry,
  sleepAbortable,
  type TwitterApiRequestOptions,
} from "./http.js";
import { asTweet } from "./tweet.js";

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
export function isTruncated(stoppedBy: SearchTermination): boolean {
  return stoppedBy === "page-cap" || stoppedBy === "cursor-cycle" || stoppedBy === "cursor-missing";
}

/**
 * Decide the next page, or record an honest reason for stopping.
 *
 * `has_next_page !== true` genuinely means "no more results". Reporting the same
 * when upstream says there ARE more pages but hands us no cursor would present a
 * partial result as complete, so that case counts as truncation instead.
 */
export function advanceOrStop(
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
