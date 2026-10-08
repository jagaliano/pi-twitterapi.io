import type { TwitterConfig } from "../config.js";
import { formatTwitterResults } from "../format.js";
import type { TwitterSearchDetails } from "../types.js";
import {
  synthesizeAnswer,
  synthesizeDocument,
  synthesizeTrends,
  synthesizeUserAnswer,
  type SynthesisDeps,
} from "../synthesize.js";
import {
  fetchCommunityTweets,
  fetchFollowers,
  fetchFollowings,
  fetchListTweets,
  fetchSpaceDetail,
  fetchThread,
  fetchTrends,
  fetchTweetQuotes,
  fetchTweetReplies,
  fetchTweetsByIds,
  fetchTweetRetweeters,
  fetchUserAbout,
  fetchUserMentions,
  fetchUserProfile,
  fetchUserTweets,
  normalizeParams,
  searchTweets,
  searchUsers,
  tweetIdFromInput,
  type ReplySort,
  type Tweet,
  type TwitterApiSearchParams,
  type UserProfile,
} from "../twitterapi.js";
import { toSynthesisModel, type TwitterApiSynthesisOptions } from "./model.js";
import { createFetchMedia } from "./media.js";
import { createProcessVideo } from "./video.js";
import { applyFallbackNote, resolveSynthesisBackend, type SynthesisBackend } from "./synthesis.js";

export interface TwitterApiRunOptions extends TwitterApiSynthesisOptions {
  params: TwitterApiSearchParams;
}

export interface TwitterApiUserSearchOptions extends TwitterApiSynthesisOptions {
  /** Keyword to match against account names, handles and bios. */
  query: string;
  /** Max accounts to collect (default 20, max 50). */
  count?: number;
  /** Max pages to fetch (default 3). */
  maxPages?: number;
}

export interface TwitterApiThreadOptions extends TwitterApiSynthesisOptions {
  /** A post id or an X permalink of any post in the thread. */
  tweet: string;
  /**
   * The user's actual question about the thread. Kept separate from `tweet`
   * because the reference only locates the thread — using it as the synthesis
   * question would leave the model unable to answer what was asked.
   */
  query: string;
  /** Max pages of thread context (default: `config.maxPages`). */
  maxPages?: number;
}

/**
 * Resolve a page budget: an explicit value is validated first, then clamped to
 * the configured ceiling. Clamping before validating would turn `Infinity` or
 * `20.5` into a valid `20` and hide the caller's mistake.
 */
function pageBudget(explicit: number | undefined, config: TwitterConfig): number {
  if (explicit !== undefined && (!Number.isInteger(explicit) || explicit < 1)) {
    throw new Error(`twitter maxPages must be a positive integer (got ${String(explicit)})`);
  }
  return Math.min(explicit ?? config.maxPages, config.maxPagesCeiling);
}

/** Why retrieval stopped short of exhausting the upstream, or undefined. */
function incompleteReason(stoppedBy: string | undefined, pages: number): string | undefined {
  if (stoppedBy === "cursor-cycle") return "the upstream cursor began repeating";
  if (stoppedBy === "cursor-missing") return "the upstream reported more results without a cursor to fetch them";
  if (stoppedBy === "page-cap") return `the ${pages}-page fetch limit was reached`;
  return undefined;
}

/** Build synthesis deps, wiring the optional bound video pre-processor (M5). */
function mediaDeps(
  backend: Pick<SynthesisBackend, "complete" | "fetcher" | "budget">,
  options: TwitterApiSynthesisOptions,
): SynthesisDeps {
  return {
    complete: backend.complete,
    inputBudget: backend.budget,
    fetchMedia: createFetchMedia(backend.fetcher, options.signal),
    processVideo: options.config.enableVideoProcessing
      ? createProcessVideo({
          fetcher: options.fetcher ?? fetch,
          env: options.env ?? {},
          signal: options.signal,
          exec: options.videoExec,
        })
      : undefined,
  };
}

/** Append config-level disclosures (ignored project keys, switch warnings). */
function appendConfigNotes(options: TwitterApiSynthesisOptions, details: TwitterSearchDetails): void {
  if (options.config.configNotes.length > 0) {
    details.notes = [...(details.notes ?? []), ...options.config.configNotes];
  }
}

/**
 * Retrieve posts from twitterapi.io and synthesize the answer, returning the
 * shared `{ markdown, details }` shape.
 */
export async function runTwitterApiSearch(
  options: TwitterApiRunOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.params.query);
  const { fetcher, apiKey, model, complete } = backend;

  const params = normalizeParams(options.params);
  const search = await searchTweets(params, apiKey, fetcher, {
    signal: options.signal,
    minRequestIntervalMs: options.config.minRequestIntervalMs,
    retryBaseDelayMs: options.config.retryBaseDelayMs,
    maxPages: options.config.maxPages,
    maxPagesCeiling: options.config.maxPagesCeiling,
    localUtcOffsetMinutes: options.localUtcOffsetMinutes,
  });

  // Retrieval that stopped short of the upstream's last page is incomplete, and
  // must not be presented as an exhaustive answer to the query.
  const incomplete = incompleteReason(search.stoppedBy, search.pagesFetched ?? 0);

  const details = await synthesizeAnswer({
    query: params.query,
    tweets: search.tweets,
    config: options.config,
    model: toSynthesisModel(model),
    signal: options.signal,
    incomplete,
    deps: mediaDeps(backend, options),
  });

  if (search.window?.shortfallHours) {
    details.notes = [
      ...(details.notes ?? []),
      `Date window coverage: the upstream search stops ${search.window.shortfallHours}h before the end of the requested local window.`,
    ];
  }
  if (incomplete) {
    details.notes = [
      ...(details.notes ?? []),
      `Retrieval stopped early (${incomplete}) while the upstream still had more posts, so these results may be incomplete.`,
    ];
  }
  // Explain pages that bought nothing: east of UTC-4 the upstream day boundary
  // sits past local midnight, so the newest posts of the scan are always outside
  // the requested day and must be paged past before the real results begin.
  if (search.trimmedNewer) {
    const band = search.window?.trimHours;
    details.notes = [
      ...(details.notes ?? []),
      `${search.trimmedNewer} newer post(s) outside the requested local window were skipped while paging to it` +
        (band ? ` (twitterapi.io resolves date bounds at 04:00 UTC, ${band}h past local midnight at this offset)` : "") +
        ".",
    ];
  }
  if (search.trimmedOlder) {
    details.notes = [
      ...(details.notes ?? []),
      `${search.trimmedOlder} older post(s) before the requested local window were skipped ` +
        "(the upstream window is padded back a day so the local day's start is covered).",
    ];
  }
  applyFallbackNote(backend, details);
  appendConfigNotes(options, details);

  return { markdown: formatTwitterResults(details), details };
}

/**
 * Search X accounts by keyword and summarize them, with profile URLs as the
 * sources.
 */
export async function runTwitterApiUserSearch(
  options: TwitterApiUserSearchOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const { fetcher, apiKey, model, complete } = backend;

  const search = await searchUsers(options.query, apiKey, fetcher, {
    signal: options.signal,
    count: options.count,
    // Configured budgets apply here too: the ceiling is a hard cap, and the base
    // budget is the configured one rather than this endpoint's own default.
    maxPages: pageBudget(options.maxPages, options.config),
    minRequestIntervalMs: options.config.minRequestIntervalMs,
    retryBaseDelayMs: options.config.retryBaseDelayMs,
  });

  const incomplete = incompleteReason(search.stoppedBy, search.pagesFetched);
  const details = await synthesizeUserAnswer({
    query: search.query,
    users: search.users,
    config: options.config,
    model: toSynthesisModel(model),
    signal: options.signal,
    incomplete,
    deps: { complete, inputBudget: backend.budget },
  });
  if (incomplete) {
    details.notes = [
      ...(details.notes ?? []),
      `Retrieval stopped early (${incomplete}) while the upstream still had more accounts, so this list may be incomplete.`,
    ];
  }
  // Measured: the endpoint matches a sub-string with no word boundaries, and a
  // multi-word query can return nothing at all ("pi coding agent" returned zero
  // accounts while "coding" returned twenty). Say so instead of leaving an empty
  // answer unexplained.
  if (search.users.length === 0 && search.query.trim().split(/\s+/).length > 1) {
    details.notes = [
      ...(details.notes ?? []),
      "twitterapi.io matches account search against a sub-string of names, handles and bios with no word boundaries, " +
        'and a multi-word query can match nothing; retry with a single distinctive keyword (for example "coding").',
    ];
  }
  applyFallbackNote(backend, details);
  appendConfigNotes(options, details);
  return { markdown: formatTwitterResults(details), details };
}

/**
 * Fetch a post's thread context and answer from it.
 */
export async function runTwitterApiThread(
  options: TwitterApiThreadOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const { fetcher, apiKey, model, complete } = backend;
  // Validated before the request, like the post and account paths: a blank
  // question would otherwise still pay for retrieval and synthesis.
  const question = options.query?.trim();
  if (!question) throw new Error("twitter query must not be empty");

  const thread = await fetchThread(options.tweet, apiKey, fetcher, {
    signal: options.signal,
    maxPages: pageBudget(options.maxPages, options.config),
    minRequestIntervalMs: options.config.minRequestIntervalMs,
    retryBaseDelayMs: options.config.retryBaseDelayMs,
  });

  const incomplete = incompleteReason(thread.stoppedBy, thread.pagesFetched);
  const details = await synthesizeAnswer({
    // The question, not the reference: the reference only located the thread.
    query: question,
    tweets: thread.tweets,
    config: options.config,
    model: toSynthesisModel(model),
    signal: options.signal,
    incomplete,
    deps: mediaDeps(backend, options),
  });
  details.notes = [
    ...(details.notes ?? []),
    `Answered from the thread context of post ${thread.tweetId} (${thread.tweets.length} post(s), ${thread.pagesFetched} page(s)).`,
  ];
  if (incomplete) {
    details.notes = [
      ...(details.notes ?? []),
      `Retrieval stopped early (${incomplete}) while the thread continued, so these results may be incomplete.`,
    ];
  }
  applyFallbackNote(backend, details);
  appendConfigNotes(options, details);
  return { markdown: formatTwitterResults(details), details };
}

// ------------------------------------------------ extended reads (P1)

/** Shared synthesis hop for the tweet-shaped reads (timeline, replies, quotes). */
async function completeTweetAnswer(
  backend: SynthesisBackend,
  options: TwitterApiSynthesisOptions,
  input: { query: string; tweets: Tweet[]; incomplete?: string; notes: string[] },
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const details = await synthesizeAnswer({
    query: input.query,
    tweets: input.tweets,
    config: options.config,
    model: toSynthesisModel(backend.model),
    signal: options.signal,
    incomplete: input.incomplete,
    deps: mediaDeps(backend, options),
  });
  details.notes = [...(details.notes ?? []), ...input.notes];
  applyFallbackNote(backend, details);
  appendConfigNotes(options, details);
  return { markdown: formatTwitterResults(details), details };
}

/** Page/pacing options every extended read takes from the config. */
function tweetReadOptions(options: TwitterApiSynthesisOptions) {
  return {
    signal: options.signal,
    maxPages: options.config.maxPages,
    maxPagesCeiling: options.config.maxPagesCeiling,
    minRequestIntervalMs: options.config.minRequestIntervalMs,
    retryBaseDelayMs: options.config.retryBaseDelayMs,
  };
}

export interface TwitterApiUserTimelineOptions extends TwitterApiSynthesisOptions {
  query: string;
  userName?: string;
  userId?: string;
  includeReplies?: boolean;
  limit?: number;
}

/** Fetch an account's recent posts and synthesize an answer from them. */
export async function runTwitterApiUserTimeline(
  options: TwitterApiUserTimelineOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const timeline = await fetchUserTweets(
    { userName: options.userName, userId: options.userId },
    backend.apiKey,
    backend.fetcher,
    { ...tweetReadOptions(options), includeReplies: options.includeReplies, limit: options.limit },
  );
  const incomplete = incompleteReason(timeline.stoppedBy, timeline.pagesFetched);
  const who = options.userName ? `@${options.userName.replace(/^@+/, "")}` : (options.userId ?? "the account");
  const notes = [`Answered from the recent timeline of ${who} (${timeline.tweets.length} post(s)).`, ...(timeline.pinNotes ?? [])];
  if (incomplete) {
    notes.push(`Retrieval stopped early (${incomplete}) while the timeline continued, so these results may be incomplete.`);
  }
  return completeTweetAnswer(backend, options, { query: options.query, tweets: timeline.tweets, incomplete, notes });
}

export interface TwitterApiRepliesOptions extends TwitterApiSynthesisOptions {
  query: string;
  tweet: string;
  queryType?: ReplySort;
  limit?: number;
}

/** Fetch replies to a post and synthesize an answer from them. */
export async function runTwitterApiReplies(
  options: TwitterApiRepliesOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const replies = await fetchTweetReplies(options.tweet, backend.apiKey, backend.fetcher, {
    ...tweetReadOptions(options),
    queryType: options.queryType,
    limit: options.limit,
  });
  const incomplete = incompleteReason(replies.stoppedBy, replies.pagesFetched);
  const count = replies.tweets.length;
  const notes = [`Answered from ${count} repl${count === 1 ? "y" : "ies"} to post ${replies.tweetId}.`];
  if (incomplete) {
    notes.push(`Retrieval stopped early (${incomplete}) while more replies remained, so these results may be incomplete.`);
  }
  return completeTweetAnswer(backend, options, { query: options.query, tweets: replies.tweets, incomplete, notes });
}

export interface TwitterApiQuotesOptions extends TwitterApiSynthesisOptions {
  query: string;
  tweet: string;
  sinceTime?: number;
  untilTime?: number;
  includeReplies?: boolean;
  limit?: number;
}

/** Fetch quote-posts of a post and synthesize an answer from them. */
export async function runTwitterApiQuotes(
  options: TwitterApiQuotesOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const quotes = await fetchTweetQuotes(options.tweet, backend.apiKey, backend.fetcher, {
    ...tweetReadOptions(options),
    sinceTime: options.sinceTime,
    untilTime: options.untilTime,
    includeReplies: options.includeReplies,
    limit: options.limit,
  });
  const incomplete = incompleteReason(quotes.stoppedBy, quotes.pagesFetched);
  const count = quotes.tweets.length;
  const notes = [`Answered from ${count} quote-post${count === 1 ? "" : "s"} of post ${quotes.tweetId}.`];
  if (incomplete) {
    notes.push(`Retrieval stopped early (${incomplete}) while more quotes remained, so these results may be incomplete.`);
  }
  return completeTweetAnswer(backend, options, { query: options.query, tweets: quotes.tweets, incomplete, notes });
}

export interface TwitterApiTrendsOptions extends TwitterApiSynthesisOptions {
  query: string;
  woeid: number;
  count?: number;
}

/** Fetch a location's trending topics and synthesize an answer from them. */
export async function runTwitterApiTrends(
  options: TwitterApiTrendsOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const { trends } = await fetchTrends(options.woeid, backend.apiKey, backend.fetcher, {
    signal: options.signal,
    count: options.count,
    minRequestIntervalMs: options.config.minRequestIntervalMs,
    retryBaseDelayMs: options.config.retryBaseDelayMs,
  });
  const details = await synthesizeTrends({
    query: options.query,
    trends,
    model: toSynthesisModel(backend.model),
    signal: options.signal,
    deps: { complete: backend.complete, inputBudget: backend.budget },
  });
  applyFallbackNote(backend, details);
  appendConfigNotes(options, details);
  return { markdown: formatTwitterResults(details), details };
}

// ------------------------------------------------ accounts & lookups (P2)

/** Shared synthesis hop for the account-shaped reads (followers, profile). */
async function completeUserAnswer(
  backend: SynthesisBackend,
  options: TwitterApiSynthesisOptions,
  input: { query: string; users: UserProfile[]; incomplete?: string; notes: string[] },
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const details = await synthesizeUserAnswer({
    query: input.query,
    users: input.users,
    config: options.config,
    model: toSynthesisModel(backend.model),
    signal: options.signal,
    incomplete: input.incomplete,
    deps: { complete: backend.complete, inputBudget: backend.budget },
  });
  details.notes = [...(details.notes ?? []), ...input.notes];
  applyFallbackNote(backend, details);
  appendConfigNotes(options, details);
  return { markdown: formatTwitterResults(details), details };
}

/** Retry/pacing options every lookup takes from the config. */
function lookupOptions(options: TwitterApiSynthesisOptions) {
  return {
    signal: options.signal,
    minRequestIntervalMs: options.config.minRequestIntervalMs,
    retryBaseDelayMs: options.config.retryBaseDelayMs,
  };
}

export interface TwitterApiMentionsOptions extends TwitterApiSynthesisOptions {
  query: string;
  userName: string;
  sinceTime?: number;
  untilTime?: number;
  limit?: number;
}

/** Fetch posts that mention an account and synthesize an answer from them. */
export async function runTwitterApiMentions(
  options: TwitterApiMentionsOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const mentions = await fetchUserMentions(options.userName, backend.apiKey, backend.fetcher, {
    ...tweetReadOptions(options),
    sinceTime: options.sinceTime,
    untilTime: options.untilTime,
    limit: options.limit,
  });
  const incomplete = incompleteReason(mentions.stoppedBy, mentions.pagesFetched);
  const notes = [`Answered from ${mentions.tweets.length} mention(s) of @${mentions.userName}.`];
  if (incomplete) {
    notes.push(`Retrieval stopped early (${incomplete}) while more mentions remained, so these results may be incomplete.`);
  }
  return completeTweetAnswer(backend, options, { query: options.query, tweets: mentions.tweets, incomplete, notes });
}

export interface TwitterApiFollowOptions extends TwitterApiSynthesisOptions {
  query: string;
  userName: string;
  pageSize?: number;
  limit?: number;
}

async function runFollow(
  options: TwitterApiFollowOptions,
  direction: "followers" | "followings",
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const fetchFn = direction === "followers" ? fetchFollowers : fetchFollowings;
  const result = await fetchFn(options.userName, backend.apiKey, backend.fetcher, {
    ...tweetReadOptions(options),
    pageSize: options.pageSize,
    limit: options.limit,
  });
  const incomplete = incompleteReason(result.stoppedBy, result.pagesFetched);
  const notes = [`Answered from ${result.users.length} ${direction} of @${result.userName}.`];
  if (incomplete) {
    notes.push(`Retrieval stopped early (${incomplete}) while more ${direction} remained, so these results may be incomplete.`);
  }
  return completeUserAnswer(backend, options, { query: options.query, users: result.users, incomplete, notes });
}

/** Fetch an account's followers and synthesize an answer from the profiles. */
export async function runTwitterApiFollowers(
  options: TwitterApiFollowOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  return runFollow(options, "followers");
}

/** Fetch the accounts an account follows and synthesize an answer. */
export async function runTwitterApiFollowings(
  options: TwitterApiFollowOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  return runFollow(options, "followings");
}

export interface TwitterApiProfileOptions extends TwitterApiSynthesisOptions {
  query: string;
  userName: string;
}

/** Fetch one account profile and synthesize an answer from it. */
export async function runTwitterApiProfile(
  options: TwitterApiProfileOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const user = await fetchUserProfile(options.userName, backend.apiKey, backend.fetcher, lookupOptions(options));
  return completeUserAnswer(backend, options, {
    query: options.query,
    users: [user],
    notes: [`Answered from the profile of @${user.handle}.`],
  });
}

export interface TwitterApiTweetsByIdsOptions extends TwitterApiSynthesisOptions {
  query: string;
  ids: string[];
}

/** Fetch specific posts by id and synthesize an answer from them. */
export async function runTwitterApiTweetsByIds(
  options: TwitterApiTweetsByIdsOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const result = await fetchTweetsByIds(options.ids, backend.apiKey, backend.fetcher, lookupOptions(options));
  const notes = [`Answered from ${result.tweets.length} post(s) fetched by id.`];
  // Asking for five posts and reporting "3 post(s)" hides the fact that two were
  // never returned — deleted, protected, or simply missing upstream (G9).
  const requested = new Set(
    options.ids.map((raw) => tweetIdFromInput(raw)).filter((id): id is string => Boolean(id)),
  );
  const returned = new Set(result.tweets.map((tweet) => tweet.id).filter((id): id is string => Boolean(id)));
  const missing = [...requested].filter((id) => !returned.has(id));
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).join(", ");
    notes.push(
      `${missing.length} requested post id(s) were not returned by the upstream: ${shown}` +
        `${missing.length > 10 ? `, and ${missing.length - 10} more` : ""}.`,
    );
  }
  return completeTweetAnswer(backend, options, {
    query: options.query,
    tweets: result.tweets,
    notes,
  });
}

export interface TwitterApiAboutOptions extends TwitterApiSynthesisOptions {
  query: string;
  userName: string;
}

/** Fetch a user's extended "about" page metadata and synthesize an answer. */
export async function runTwitterApiAbout(
  options: TwitterApiAboutOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const about = await fetchUserAbout(options.userName, backend.apiKey, backend.fetcher, lookupOptions(options));
  const fields = flattenObject(about as unknown as Record<string, unknown>);
  const notes = [`Answered from the about page of @${about.handle}.`];
  if (fields.length > 200) {
    notes.push(`The about data was long; only the first 200 of ${fields.length} fields were used, so some may be omitted.`);
  }
  const details = await synthesizeDocument({
    query: options.query,
    title: `About @${about.handle}`,
    body: fields.slice(0, 200).join("\n"),
    citations: [about.profileUrl],
    model: toSynthesisModel(backend.model),
    signal: options.signal,
    deps: { complete: backend.complete, inputBudget: backend.budget },
    notes,
  });
  applyFallbackNote(backend, details);
  appendConfigNotes(options, details);
  return { markdown: formatTwitterResults(details), details };
}

export interface TwitterApiRetweetersOptions extends TwitterApiSynthesisOptions {
  query: string;
  tweet: string;
  limit?: number;
}

/** Fetch users who retweeted a post and synthesize an answer from their profiles. */
export async function runTwitterApiRetweeters(
  options: TwitterApiRetweetersOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const result = await fetchTweetRetweeters(options.tweet, backend.apiKey, backend.fetcher, {
    ...tweetReadOptions(options),
    limit: options.limit,
  });
  const incomplete = incompleteReason(result.stoppedBy, result.pagesFetched);
  const notes = [`Answered from ${result.users.length} retweeter(s) of post ${result.tweetId}.`];
  if (incomplete) {
    notes.push(`Retrieval stopped early (${incomplete}) while more retweeters remained, so these results may be incomplete.`);
  }
  return completeUserAnswer(backend, options, { query: options.query, users: result.users, incomplete, notes });
}

// -------------------------------------- communities, lists, spaces (P3)

export interface TwitterApiCommunityOptions extends TwitterApiSynthesisOptions {
  query: string;
  communityId: string;
  limit?: number;
}

/** Fetch a community's posts and synthesize an answer from them. */
export async function runTwitterApiCommunity(
  options: TwitterApiCommunityOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const result = await fetchCommunityTweets(options.communityId, backend.apiKey, backend.fetcher, {
    ...tweetReadOptions(options),
    limit: options.limit,
  });
  const incomplete = incompleteReason(result.stoppedBy, result.pagesFetched);
  const notes = [`Answered from ${result.tweets.length} post(s) in community ${options.communityId}.`];
  if (incomplete) {
    notes.push(`Retrieval stopped early (${incomplete}) while more community posts remained, so these results may be incomplete.`);
  }
  return completeTweetAnswer(backend, options, { query: options.query, tweets: result.tweets, incomplete, notes });
}

export interface TwitterApiListOptions extends TwitterApiSynthesisOptions {
  query: string;
  listId: string;
  limit?: number;
}

/** Fetch a list's timeline and synthesize an answer from it. */
export async function runTwitterApiList(
  options: TwitterApiListOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const result = await fetchListTweets(options.listId, backend.apiKey, backend.fetcher, {
    ...tweetReadOptions(options),
    limit: options.limit,
  });
  const incomplete = incompleteReason(result.stoppedBy, result.pagesFetched);
  const notes = [`Answered from ${result.tweets.length} post(s) in list ${options.listId}.`];
  if (incomplete) {
    notes.push(`Retrieval stopped early (${incomplete}) while more list posts remained, so these results may be incomplete.`);
  }
  return completeTweetAnswer(backend, options, { query: options.query, tweets: result.tweets, incomplete, notes });
}

/** Flatten a nested object into bounded `key: value` lines for synthesis. */
function flattenObject(data: Record<string, unknown>, prefix = ""): string[] {
  const lines: string[] = [];
  // A value containing a line break would emit a forged `key: value` line of its
  // own, so it is flattened the same way retrieved post text is (G1).
  const scalar = (value: unknown): string => String(value).replace(/[\r\n\u2028\u2029]+/g, " ⏎ ");
  for (const [key, value] of Object.entries(data)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      // Index each member so an identity inside an object array (for example a
      // Space speaker) survives instead of collapsing to an item count.
      value.forEach((item, index) => {
        if (item !== null && typeof item === "object") {
          lines.push(...flattenObject(item as Record<string, unknown>, `${label}[${index}]`));
        } else {
          lines.push(`${label}[${index}]: ${scalar(item)}`);
        }
      });
    } else if (typeof value === "object") {
      lines.push(...flattenObject(value as Record<string, unknown>, label));
    } else {
      lines.push(`${label}: ${scalar(value)}`);
    }
  }
  return lines;
}

export interface TwitterApiSpaceOptions extends TwitterApiSynthesisOptions {
  query: string;
  spaceId: string;
}

/** Fetch an X Space's detail and synthesize an answer from it. */
export async function runTwitterApiSpace(
  options: TwitterApiSpaceOptions,
): Promise<{ markdown: string; details: TwitterSearchDetails }> {
  const backend = resolveSynthesisBackend(options, options.query);
  const space = await fetchSpaceDetail(options.spaceId, backend.apiKey, backend.fetcher, lookupOptions(options));
  const fields = flattenObject(space.data);
  const body = fields.slice(0, 200).join("\n");
  const notes =
    fields.length > 200
      ? [`The Space detail was long; only the first 200 of ${fields.length} fields were used, so some fields may be omitted.`]
      : [];
  const details = await synthesizeDocument({
    query: options.query,
    title: `X Space ${space.id}`,
    body,
    citations: [`https://x.com/i/spaces/${space.id}`],
    model: toSynthesisModel(backend.model),
    signal: options.signal,
    deps: { complete: backend.complete, inputBudget: backend.budget },
    notes,
  });
  applyFallbackNote(backend, details);
  appendConfigNotes(options, details);
  return { markdown: formatTwitterResults(details), details };
}
