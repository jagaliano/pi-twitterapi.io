import { isObject, type Tweet, type TweetMedia, type UserProfile } from "./core.js";


function asMedia(raw: unknown): TweetMedia | undefined {
  if (!isObject(raw)) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const variants = isObject(raw.video_info) && Array.isArray(raw.video_info.variants) ? raw.video_info.variants : [];
  const playableVariants = variants
    .filter((v) => isObject(v) && typeof v.url === "string" && v.content_type === "video/mp4")
    .map((v) => {
      const record = v as Record<string, unknown>;
      const bitrate = typeof record.bitrate === "number" && Number.isFinite(record.bitrate) ? record.bitrate : undefined;
      return { url: String(record.url), bitrate };
    })
    .sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
  const playable = playableVariants.map((v) => v.url);
  const duration = isObject(raw.video_info) && typeof raw.video_info.duration_millis === "number" ? raw.video_info.duration_millis : undefined;
  const mediaId = typeof raw.id_str === "string" && /^\d{1,20}$/.test(raw.id_str) ? raw.id_str : undefined;
  const media: TweetMedia = {
    ...(mediaId ? { id: mediaId } : {}),
    type: str(raw.type),
    url: str(raw.media_url_https) ?? str(raw.media_url),
    videoVariants: playable.length > 0 ? playable : undefined,
    videoVariantsDetailed: playableVariants.length > 0 ? playableVariants : undefined,
    durationMillis: duration,
  };
  return media.url || media.videoVariants ? media : undefined;
}

function asMediaList(raw: unknown): TweetMedia[] | undefined {
  if (!isObject(raw) || !Array.isArray(raw.media)) return undefined;
  const list = raw.media.map(asMedia).filter((m): m is TweetMedia => m !== undefined);
  return list.length > 0 ? list : undefined;
}

const MAX_TWEET_DEPTH = 1;

export function asTweet(raw: unknown): Tweet | undefined {
  return mapTweet(raw, 0);
}

function asNestedTweet(raw: unknown, depth: number): Tweet | undefined {
  const tweet = mapTweet(raw, depth);
  // Upstream id-only stubs are not fetched context. Keep media-only sources,
  // including those without a text field, without inventing their identity.
  if (!tweet || (!tweet.text?.trim() && !tweet.url?.trim() && !tweet.media?.length)) return undefined;
  return tweet;
}

function mapTweet(raw: unknown, depth: number): Tweet | undefined {
  if (!isObject(raw) || (typeof raw.text !== "string" && !(depth > 0 && raw.text == null))) return undefined;
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
    text: typeof raw.text === "string" ? raw.text : "",
    createdAt: str(raw.createdAt),
    likeCount: num(raw.likeCount),
    retweetCount: num(raw.retweetCount),
    replyCount: num(raw.replyCount),
    viewCount: num(raw.viewCount),
    quoteCount: typeof raw.quoteCount === "number" && Number.isFinite(raw.quoteCount) ? raw.quoteCount : undefined,
    lang: str(raw.lang),
    isReply: typeof raw.isReply === "boolean" ? raw.isReply : undefined,
    inReplyToUsername: str(raw.inReplyToUsername),
    quoted: depth < MAX_TWEET_DEPTH ? asNestedTweet(raw.quoted_tweet, depth + 1) : undefined,
    retweetOf: depth < MAX_TWEET_DEPTH ? asNestedTweet(raw.retweeted_tweet, depth + 1) : undefined,
    author: author ? {
      userName: str(author.userName),
      name: str(author.name),
      followers: num(author.followers),
    } : undefined,
    media,
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

export function asUser(raw: unknown): UserProfile | undefined {
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

