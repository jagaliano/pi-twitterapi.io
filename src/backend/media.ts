import { toBase64, type ImageAttachment } from "../synthesize.js";

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 20_000;

/** Read a body while enforcing a byte cap, so an oversized response is never fully buffered. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | undefined> {
  const body = response.body;
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface FetchMediaLimits {
  /** Maximum accepted image size in bytes (default 8 MiB). */
  maxBytes?: number;
  /** Per-download deadline covering the body read (default 20s). */
  timeoutMs?: number;
}

/** Twitter media CDN domains whose URLs may be downloaded for synthesis. */
export const ALLOWED_MEDIA_HOSTS = ["twimg.com"] as const;

/**
 * True for an HTTPS URL on a known Twitter media host.
 *
 * Post media URLs come from the upstream API and are therefore attacker-
 * influenceable: without this check a crafted URL could point the download at
 * localhost or a private service (SSRF). Redirects are additionally refused at
 * fetch time so an allowed host cannot bounce the request inward.
 */
export function isAllowedMediaUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_MEDIA_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function createFetchMedia(fetcher: typeof fetch, callerSignal?: AbortSignal, limits: FetchMediaLimits = {}) {
  const maxBytes = limits.maxBytes ?? MAX_MEDIA_BYTES;
  const timeoutMs = limits.timeoutMs ?? MEDIA_TIMEOUT_MS;
  return async function fetchMedia(url: string, timeoutMsOverride?: number): Promise<ImageAttachment | undefined> {
    const budget = timeoutMsOverride === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMsOverride, timeoutMs));
    if (callerSignal?.aborted) return undefined;
    // Media URLs are attacker-influenceable upstream data, so the host and
    // scheme are checked before any request is made.
    if (!isAllowedMediaUrl(url)) return undefined;
    // A stalled image must not outlive the tool call: the download carries the
    // caller's signal and its own deadline, covering the body read too. A caller
    // may shorten that deadline (the media phase passes what remains of its
    // budget) but never extend it.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await fetcher(url, { signal: controller.signal, redirect: "error" });
      if (!response.ok) return undefined;
      const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!mimeType.startsWith("image/")) return undefined;
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) return undefined;
      const bytes = await readCapped(response, maxBytes);
      if (!bytes) return undefined;
      return { data: toBase64(bytes), mimeType };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }
  };
}
