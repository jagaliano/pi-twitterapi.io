import {
  TWITTERAPI_BASE_URL,
  isObject,
  type FetchLike,
  type SearchTermination,
  type Tweet,
  type TwitterApiSearchParams,
  type UserProfile,
} from "./core.js";
import { asTweet, asUser, metadataUrl, statusIdFromUrl, tweetIdFromInput } from "./tweet.js";
import {
  CancelledError,
  DEFAULT_MAX_PAGES_CEILING,
  MAX_PAGE_BOUND,
  boundedCount,
  ensureSuccessfulPayload,
  requestWithRetry,
  resolveRequestSettings,
  sleepAbortable,
  type TwitterApiRequestOptions,
} from "./http.js";
import { advanceOrStop, isTruncated } from "./search.js";

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
  /** Honest pin availability, without an implicit extra paid lookup. */
  pinNotes?: string[];
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
  const pins = new Map<string, { id?: string; url?: string; tweet?: Tweet }>();
  const identity = (post: { id?: unknown; url?: unknown }) => {
    const url = metadataUrl(post.url);
    const urlId = url ? statusIdFromUrl(url) : undefined;
    const id = typeof post.id === "string" && /^\d{1,25}$/.test(post.id) ? post.id
      : urlId && /^\d{1,25}$/.test(urlId) ? urlId : undefined;
    return { id, url: urlId ? url : undefined };
  };
  const samePin = (pin: { id?: string; url?: string }, post: Tweet) => {
    const known = identity(post);
    if (pin.id && known.id && pin.id !== known.id) return false;
    return Boolean((pin.id && pin.id === known.id) || (pin.url && pin.url === known.url));
  };
  const usable = (post: Tweet) => Boolean(post.text?.trim() || post.media?.length);
  let unreadablePin = false;
  const result = await walkTweets(USER_LAST_TWEETS_PATH, apiKey, fetcher, {
    ...paging,
    params: { userName, userId, includeReplies: includeReplies === true ? "true" : undefined },
    // `/twitter/user/last_tweets` returns `{ data: { tweets, pin_tweet } }`,
    // unlike the other reads that put `tweets` at the top level.
    extract: (payload) => {
      const data = payload.data;
      if (isObject(data) && Array.isArray(data.tweets)) {
        const rawPin = data.pin_tweet;
        const known = identity(isObject(rawPin) ? rawPin : { id: rawPin });
        // Non-null pin shape was not measured in the spike. Consume only an
        // actual full tweet in the existing schema; ids/stubs are metadata only.
        const pin = asTweet(rawPin);
        const key = known.id ? `id:${known.id}` : known.url ? `url:${known.url}` : undefined;
        if (key) pins.set(key, { ...known, url: known.url ?? pins.get(key)?.url, tweet: pin && usable(pin) ? pin : pins.get(key)?.tweet });
        if (pin && usable(pin) && isObject(rawPin)) {
          return [{ ...rawPin, isPinned: true }, ...data.tweets];
        }
        if (rawPin != null && !key) unreadablePin = true;
        return data.tweets;
      }
      return Array.isArray(payload.tweets) ? payload.tweets : undefined;
    },
  });
  const reported = [...pins.values()];
  const reconciled = result.tweets.map((tweet) => {
    const pin = reported.find((candidate) => samePin(candidate, tweet));
    // Paging can discard a full pin by an earlier URL-only copy. Upgrade from
    // that actually fetched pin, not from an id/stub or another post's content.
    const retained = pin?.tweet ? { ...pin.tweet, id: pin.tweet.id ?? tweet.id, url: pin.tweet.url ?? tweet.url } : tweet;
    return pin && usable(retained) ? { ...retained, isPinned: true } : retained;
  });
  // Upgrades can turn separately paged permalink aliases into identical pins.
  // Coalesce after reconciliation, retaining first-source order and fetched data.
  const seenPinIds = new Set<string>();
  const seenPinUrls = new Set<string>();
  const tweets = reconciled.filter((tweet) => {
    if (!tweet.isPinned) return true;
    const known = identity(tweet);
    const duplicate = Boolean((known.id && seenPinIds.has(known.id)) || (known.url && seenPinUrls.has(known.url)));
    if (known.id) seenPinIds.add(known.id);
    if (known.url) seenPinUrls.add(known.url);
    return !duplicate;
  });
  const missing = reported.filter((pin) => !tweets.some((tweet) => samePin(pin, tweet) && usable(tweet)));
  const pinNotes: string[] = [];
  if (reconciled.length > tweets.length) pinNotes.push(`Coalesced ${reconciled.length - tweets.length} duplicate pinned occurrence(s) after identity reconciliation.`);
  if (missing.length) pinNotes.push(`Pin metadata indicates ${missing.length} post(s) whose usable content was not returned in the retained timeline; no extra pin lookup was attempted.`);
  if (unreadablePin) pinNotes.push("Upstream pin metadata was not a recognised tweet or post id; no pin content was inferred.");
  return { ...result, tweets, userName, userId, pinNotes: pinNotes.length ? pinNotes : undefined };
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

// --------------------------------------- about & retweeters (P2b)

export const USER_ABOUT_PATH = "/twitter/user_about";
export const TWEET_RETWEETERS_PATH = "/twitter/tweet/retweeters";

/** Extended profile-page metadata from `/twitter/user_about`. */
export interface UserAbout {
  id?: string;
  /** Handle without "@". */
  handle: string;
  name?: string;
  bio?: string;
  createdAt?: string;
  profilePicture?: string;
  verified?: boolean;
  protected?: boolean;
  /** Country/region hint from the about page, when provided. */
  accountBasedIn?: string;
  /** Client/region the account was created from, when provided. */
  source?: string;
  locationAccurate?: boolean;
  createdCountryAccurate?: boolean;
  /** Handle-change count and when the last change happened (epoch ms). */
  usernameChanges?: { count?: number; lastChangedAtMs?: number };
  /** Identity-verification state reported on the about page. */
  identityVerified?: boolean;
  /** When identity verification was granted (epoch ms), when provided. */
  verifiedSinceMsec?: number;
  /** Always constructed: `https://x.com/<handle>`. */
  profileUrl: string;
}

/** Parse a finite number from a number or a numeric string (upstream mixes both). */
function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asUserAbout(raw: unknown): UserAbout | undefined {
  if (!isObject(raw)) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const handle = str(raw.screen_name) ?? str(raw.userName) ?? str(raw.username);
  if (!handle) return undefined;
  const about = isObject(raw.about_profile) ? raw.about_profile : undefined;
  const usernameChangesRaw = about && isObject(about.username_changes) ? about.username_changes : undefined;
  const verification = isObject(raw.verification_info) ? raw.verification_info : undefined;
  const reason = verification && isObject(verification.reason) ? verification.reason : undefined;

  const user: UserAbout = { handle, profileUrl: `https://x.com/${handle}` };
  const id = str(raw.id);
  if (id) user.id = id;
  const name = str(raw.name);
  if (name) user.name = name;
  const bio = str(raw.description) ?? str(raw.bio);
  if (bio) user.bio = bio;
  const createdAt = str(raw.createdAt) ?? str(raw.created_at);
  if (createdAt) user.createdAt = createdAt;
  const profilePicture = str(raw.profilePicture) ?? str(raw.profile_picture);
  if (profilePicture) user.profilePicture = profilePicture;
  // Booleans are preserved when supplied, including `false`: a false
  // verification, protected or accuracy flag is a real answer, and dropping it
  // would make "not verified" indistinguishable from "not reported".
  if ([raw.isBlueVerified, raw.isVerified, raw.verified].some((value) => typeof value === "boolean")) {
    user.verified = raw.isBlueVerified === true || raw.isVerified === true || raw.verified === true;
  }
  const protectedFlag = bool(raw.protected);
  if (protectedFlag !== undefined) user.protected = protectedFlag;
  const accountBasedIn = about ? str(about.account_based_in) : undefined;
  if (accountBasedIn) user.accountBasedIn = accountBasedIn;
  const source = about ? str(about.source) : undefined;
  if (source) user.source = source;
  const locationAccurate = about ? bool(about.location_accurate) : undefined;
  if (locationAccurate !== undefined) user.locationAccurate = locationAccurate;
  const createdCountryAccurate = about ? bool(about.created_country_accurate) : undefined;
  if (createdCountryAccurate !== undefined) user.createdCountryAccurate = createdCountryAccurate;
  if (usernameChangesRaw) {
    const count = finiteNumber(usernameChangesRaw.count);
    const lastChangedAtMs = finiteNumber(usernameChangesRaw.last_changed_at_msec);
    if (count !== undefined || lastChangedAtMs !== undefined) {
      user.usernameChanges = {};
      if (count !== undefined) user.usernameChanges.count = count;
      if (lastChangedAtMs !== undefined) user.usernameChanges.lastChangedAtMs = lastChangedAtMs;
    }
  }
  const identityVerified = verification ? bool(verification.is_identity_verified) : undefined;
  if (identityVerified !== undefined) user.identityVerified = identityVerified;
  const verifiedSince = reason ? finiteNumber(reason.verified_since_msec) : undefined;
  if (verifiedSince !== undefined) user.verifiedSinceMsec = verifiedSince;
  return user;
}

/** Fetch a user's extended "about" page metadata via `/twitter/user_about`. */
export async function fetchUserAbout(
  userName: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: TwitterApiRequestOptions = {},
): Promise<UserAbout> {
  const handle = requireUserName(userName, "about");
  const settings = resolveRequestSettings(options);
  const url = new URL(TWITTERAPI_BASE_URL + USER_ABOUT_PATH);
  url.searchParams.set("userName", handle);
  const { response, body, attempts, bodyError } = await requestWithRetry(url.toString(), apiKey, fetcher, settings);
  const payload = ensureSuccessfulPayload(response, body, bodyError, attempts);
  const user = asUserAbout(payload.data ?? payload);
  if (!user) throw new Error(`twitterapi.io returned no about data for "${handle}"`);
  return user;
}

export interface RetweetersDetails extends UserCollection {
  tweetId: string;
}

/** Fetch users who retweeted a post via `/twitter/tweet/retweeters`. */
export async function fetchTweetRetweeters(
  tweet: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
  options: TweetPagingOptions = {},
): Promise<RetweetersDetails> {
  const id = tweetIdFromInput(tweet);
  if (!id) throw new Error(`twitter tweet must be a numeric post id or an X permalink (got "${tweet}")`);
  const result = await walkUsers(TWEET_RETWEETERS_PATH, apiKey, fetcher, {
    ...options,
    params: { tweetId: id },
    arrayKey: "users",
  });
  return { ...result, tweetId: id };
}
