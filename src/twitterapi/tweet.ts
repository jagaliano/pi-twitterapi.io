import { isObject, type Tweet, type TweetMedia, type UserProfile } from "./core.js";


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

export function asTweet(raw: unknown): Tweet | undefined {
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

