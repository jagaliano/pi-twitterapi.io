// Explicit, bounded article reads and same-post provenance; never fetch embedded assets.
import { reportProgress } from "../progress.js";
import { TWITTERAPI_BASE_URL, isObject, type FetchLike } from "./core.js";
import { boundedCount, DEFAULT_MAX_PAGES_CEILING, MAX_PAGE_BOUND, ensureSuccessfulPayload, requestWithRetry, resolveRequestSettings, type TwitterApiRequestOptions } from "./http.js";

export const ARTICLE_RESPONSE_BYTES = 1_048_576;
export const ARTICLE_BLOCK_LIMIT = 1_000;
export const ARTICLE_SOURCE_URL_CHARS = 128;
const textTypes = new Set(["unstyled", "header-one", "header-two", "header-three", "unordered-list-item", "ordered-list-item", "markdown"]);
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const handle = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9_]{1,15}$/.test(value) ? value : undefined;
const userId = (value: unknown): string | undefined => typeof value === "string" && /^\d{1,25}$/.test(value) ? value : undefined;

export interface ArticleDetails {
  /** Requested POST id, never the endpoint's opaque ArticleEntity id. */
  tweetId: string;
  title?: string;
  author?: string;
  createdAt?: string;
  blocks: { index: number; type: string; text?: string }[];
  citations: string[];
  notes: string[];
}

/** Bound decoded HTTP bytes before JSON parsing; a billed HTTP200 body failure is not retried. */
function boundedFetcher(fetcher: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await fetcher(input, init);
    // Preserve opaque/manual redirects for the transport's non-retryable refusal.
    if (!response.body || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) return response;
    let bytes = 0;
    const capped = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > ARTICLE_RESPONSE_BYTES) throw new Error("article response exceeds the 1 MiB parsing limit");
        controller.enqueue(chunk);
      },
    }));
    return new Response(capped, { status: response.status, headers: response.headers });
  };
}

/** Strict fetched permalink: no tracking/query rewriting, guessed handle, or input-URL substitution. */
function source(raw: Record<string, unknown>, id: string, articleAuthor: Record<string, unknown>): string | undefined {
  if (raw.id !== id || typeof raw.url !== "string" || raw.url.length > ARTICLE_SOURCE_URL_CHARS || /[\s\p{C}]/u.test(raw.url)) return undefined;
  let url: URL;
  try { url = new URL(raw.url); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(url.hostname)) return undefined;
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/.exec(url.pathname);
  if (!match || match[2] !== id || !isObject(raw.author)) return undefined;
  const own = raw.author;
  // Present but malformed identities cannot be erased to sidestep a conflict.
  for (const author of [articleAuthor, own]) {
    if ((author.id !== undefined && !userId(author.id)) || (author.userName !== undefined && !handle(author.userName))) return undefined;
  }
  const aId = userId(articleAuthor.id), pId = userId(own.id);
  const aHandle = handle(articleAuthor.userName)?.toLowerCase(), pHandle = handle(own.userName)?.toLowerCase();
  if ((aId && pId && aId !== pId) || (aHandle && pHandle && aHandle !== pHandle)) return undefined;
  if (!(aId && pId && aId === pId) && !(aHandle && pHandle && aHandle === pHandle)) return undefined;
  if (!pHandle || match[1].toLowerCase() !== pHandle) return undefined;
  return raw.url;
}

export type ArticleOptions = TwitterApiRequestOptions & { maxPages?: number; maxPagesCeiling?: number };

/** One explicit article read plus at most one explicit associated-post lookup. */
export async function fetchArticle(tweetId: string, apiKey: string, fetcher: FetchLike = fetch, options: ArticleOptions = {}): Promise<ArticleDetails> {
  if (!/^\d{1,25}$/.test(tweetId)) throw new Error("twitter article needs a numeric post id");
  const ceiling = boundedCount(options.maxPagesCeiling, DEFAULT_MAX_PAGES_CEILING, MAX_PAGE_BOUND, "maxPagesCeiling");
  const budget = Math.min(boundedCount(options.maxPages, 3, MAX_PAGE_BOUND, "maxPages"), ceiling);
  if (budget < 2) throw new Error("twitter article needs a budget of 2 logical requests (article + associated post); no upstream requests were sent. Increase maxPages/maxPagesCeiling.");
  const settings = resolveRequestSettings(options), limited = boundedFetcher(fetcher);
  const read = async (path: string, param: string, value: string, provenance = false) => {
    settings.signal?.throwIfAborted();
    const url = new URL(path, TWITTERAPI_BASE_URL);
    url.searchParams.set(param, value);
    const result = await requestWithRetry(url.toString(), apiKey, limited, settings);
    settings.signal?.throwIfAborted();
    // Unusable received provenance is not an article-body failure. Preserve the
    // already-retrieved text uncited; transport/HTTP failures and cancellation
    // still propagate. Never retry a billed HTTP200 merely for parsing failure.
    if (provenance && result.response.ok && (result.bodyError || !isObject(result.body)
      || (result.body.status !== undefined && result.body.status !== "success") || !Array.isArray(result.body.tweets))) return undefined;
    // /article uses `failed` and `msg`, not just the generic `error`/`message` envelope.
    // Do not echo arbitrary upstream messages, which may contain credentials.
    if (result.response.ok && isObject(result.body) && (result.body.status === "failed" || result.body.status === "error")) {
      throw new Error("twitterapi.io article request failed (article or associated post unavailable/not found); no partial result was published.");
    }
    return ensureSuccessfulPayload(result.response, result.response.ok ? result.body : undefined, result.bodyError, result.attempts, options.telemetry);
  };
  reportProgress(options, "reading X article");
  const payload = await read("/twitter/article", "tweet_id", tweetId);
  if (!payload || payload.status !== "success" || !isObject(payload.article) || !Array.isArray(payload.article.contents)) {
    throw new Error("twitterapi.io returned a malformed article response (expected successful article.contents array)");
  }
  const raw = payload.article;
  const contents = raw.contents as unknown[];
  const blocks: ArticleDetails["blocks"] = [];
  let media = 0, unsupported = 0;
  for (const [index, block] of contents.slice(0, ARTICLE_BLOCK_LIMIT).entries()) {
    if (!isObject(block) || typeof block.type !== "string") { unsupported++; continue; }
    if (block.type === "image" || block.type === "gif") { media++; continue; }
    if (block.type === "divider") { blocks.push({ index: index + 1, type: "divider" }); continue; }
    if (!textTypes.has(block.type) || !string(block.text)) { unsupported++; continue; }
    blocks.push({ index: index + 1, type: block.type, text: String(block.text) });
  }
  const author = isObject(raw.author) ? raw.author : {};
  const notes = ["Explicit article read: text only. Cover images, image/GIF blocks and inline styling are not rendered; embedded links and media were not fetched."];
  if (media) notes.push(`${media} article image/GIF block(s) omitted.`);
  if (unsupported) notes.push(`${unsupported} unsupported, empty or malformed article block(s) omitted; the body is partial.`);
  if (contents.length > ARTICLE_BLOCK_LIMIT) notes.push(`Only the first ${ARTICLE_BLOCK_LIMIT} of ${contents.length} article blocks were parsed; the body is partial.`);
  if (!blocks.some(block => block.text)) notes.push("No readable article body text was returned; title/author metadata is not a full article body.");
  reportProgress(options, "reading X article source");
  const posts = await read("/twitter/tweets", "tweet_ids", tweetId, true);
  // One requested id should yield one root. Missing/malformed/ambiguous received
  // provenance cannot discard article text or become a guessed citation.
  const roots = posts?.tweets;
  const citation = Array.isArray(roots) && roots.length === 1 && isObject(roots[0]) ? source(roots[0], tweetId, author) : undefined;
  if (!citation) notes.push("Article source provenance could not be validated: the associated post/author identity or fetched permalink was missing, invalid, conflicting or ambiguous. No source URL was guessed or published.");
  settings.signal?.throwIfAborted();
  return { tweetId, title: string(raw.title), author: handle(author.userName), createdAt: string(raw.createdAt), blocks, citations: citation ? [citation] : [], notes };
}
