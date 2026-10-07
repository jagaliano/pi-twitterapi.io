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
  /**
   * Playable variants with bitrate, ascending. Added alongside `videoVariants`
   * (kept for back-compat) so video selection can weigh size = bitrate/8 × sec.
   */
  videoVariantsDetailed?: { url: string; bitrate?: number }[];
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
  quoteCount?: number;
  lang?: string;
  isReply?: boolean;
  inReplyToUsername?: string;
  /** One fetched nested level; empty id-only stubs are omitted. */
  quoted?: Tweet;
  /** Original source of a repost, separate from the enclosing post's identity. */
  retweetOf?: Tweet;
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
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
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
