import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, open, readdir, rename, rmdir, stat, unlink, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { reportProgress } from "../progress.js";
import { isAllowedMediaUrl } from "./media.js";
import type { ProcessVideoInput, VideoEvidence, VideoMethod } from "./video.js";

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const MAX_ENTRY_BYTES = 128_000;
const FILE = /^[a-f0-9]{64}\.json$/;
const METHODS: readonly VideoMethod[] = ["gemini-native", "openai-compatible", "frames+stt", "stt-only", "transcript-only"];
/** Bump for changes to prompts, parsers, clipping, speech filters or processing semantics. */
const PROCESSING_VERSION = 1;
interface Entry {
  schema: 1; key: string; epoch: string; analysedAt: number;
  method: VideoMethod; clipSeconds: number; transcript?: string; visualNotes?: string;
}
interface Limits { maxBytes?: number; maxEntries?: number; now?: () => number; signal?: AbortSignal }
export function cacheDirectory(agentDir = getAgentDir()): string { return join(agentDir, "twitter-evidence-cache-v1"); }
function text(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }
function eligible(e: VideoEvidence): boolean { return e.cacheable !== false && METHODS.includes(e.method) && (text(e.transcript) || text(e.visualNotes)); }
function validate(value: unknown, key: string, epoch: string, now: number): value is Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Entry;
  return Object.keys(e).every(k => ["schema", "key", "epoch", "analysedAt", "method", "clipSeconds", "transcript", "visualNotes"].includes(k)) &&
    e.schema === 1 && e.key === key && e.epoch === epoch && METHODS.includes(e.method) &&
    Number.isFinite(e.analysedAt) && e.analysedAt <= now && now - e.analysedAt < CACHE_TTL_MS &&
    Number.isFinite(e.clipSeconds) && e.clipSeconds > 0 && e.clipSeconds <= 600 &&
    (e.transcript === undefined || typeof e.transcript === "string") && (e.visualNotes === undefined || typeof e.visualNotes === "string") &&
    (text(e.transcript) || text(e.visualNotes));
}
function privateNode(s: Stats, directory: boolean): boolean {
  return !s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1) &&
    s.uid === process.getuid?.() && (s.mode & 0o777) === (directory ? 0o700 : 0o600);
}

/** Detached schema excludes attribution, operational notes, images and credential fields. */
export class TextEvidenceCache {
  readonly directory: string;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(agentDir: string, private readonly options: Limits = {}) {
    this.directory = cacheDirectory(agentDir);
    this.maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes! > 0 ? Math.min(MAX_BYTES, options.maxBytes!) : MAX_BYTES;
    this.maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries! > 0 ? Math.min(MAX_ENTRIES, options.maxEntries!) : MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }
  private active() { this.options.signal?.throwIfAborted(); }
  private async directoryExists(create: boolean): Promise<boolean> {
    this.active();
    if (create) await mkdir(this.directory, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    const s = await lstat(this.directory).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; });
    if (!s) return false;
    if (!privateNode(s, true)) throw new Error("Unsafe cache directory");
    return true;
  }
  private async read(name: string, limit: number): Promise<string | undefined> {
    this.active();
    const file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; });
    if (!file) return undefined;
    try {
      const s = await file.stat();
      if (!privateNode(s, false)) throw new Error("Unsafe cache file");
      if (s.size > limit) return undefined;
      // Read a fixed-size buffer rather than trusting a size that may change.
      const buffer = Buffer.alloc(limit + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead; this.active();
      }
      if (total > limit) return undefined;
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total)); }
      catch { return undefined; }
    } finally { await file.close(); }
  }
  private async atomic(name: string, body: string): Promise<void> {
    this.active();
    const temporary = join(this.directory, `.tmp-${randomUUID()}`);
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(body); await file.sync(); }
      finally { await file.close(); }
      this.active(); await rename(temporary, join(this.directory, name));
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  /** Cross-process writer/clear serialization. Never steal a live or orphan lock. */
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const path = join(this.directory, ".lock"), until = performance.now() + 1_000;
    for (;;) {
      this.active();
      try { await mkdir(path, { mode: 0o700 }); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (performance.now() >= until) throw new Error("Cache busy (or an abandoned writer lock)");
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    }
    try { this.active(); return await work(); }
    finally { await rmdir(path); }
  }
  async prepare(create: boolean): Promise<string | undefined> {
    if (!await this.directoryExists(create)) return undefined;
    const readEpoch = async () => {
      const epoch = await this.read(".epoch", 64);
      if (epoch && !/^[a-f0-9-]{36}$/.test(epoch)) throw new Error("Invalid cache generation");
      return epoch;
    };
    const epoch = await readEpoch();
    // Hits do not wait for an unrelated writer; get() rechecks generation.
    if (epoch || !create) return epoch;
    return this.locked(async () => {
      const existing = await readEpoch(); if (existing) return existing;
      const epoch = randomUUID(); await this.atomic(".epoch", epoch); return epoch;
    });
  }
  async get(key: string, epoch: string): Promise<Entry | undefined> {
    if (!/^[a-f0-9]{64}$/.test(key)) return undefined;
    const raw = await this.read(`${key}.json`, MAX_ENTRY_BYTES);
    if (!raw) return undefined;
    let entry: unknown; try { entry = JSON.parse(raw); } catch { return undefined; }
    // A concurrent clear invalidates reads as well as writes without attribution.
    if (await this.read(".epoch", 64) !== epoch) return undefined;
    return validate(entry, key, epoch, this.now()) ? entry : undefined;
  }
  async put(key: string, evidence: VideoEvidence, epoch: string, clip: { clipSeconds: number }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key) || !eligible(evidence)) return;
    const entry: Entry = { schema: 1, key, epoch, analysedAt: this.now(), method: evidence.method, clipSeconds: clip.clipSeconds,
      transcript: evidence.transcript, visualNotes: evidence.visualNotes };
    const body = JSON.stringify(entry);
    if (Buffer.byteLength(body) > Math.min(MAX_ENTRY_BYTES, this.maxBytes) || !validate(entry, key, epoch, this.now())) return;
    await this.locked(async () => {
      if (await this.read(".epoch", 64) !== epoch) return;
      const valid: { name: string; bytes: number; analysedAt: number }[] = [];
      // Private, regular files only; unexpected names are never deleted.
      for (const name of await readdir(this.directory)) {
        if (/^\.tmp-[a-f0-9-]{36}$/.test(name)) {
          if (!privateNode(await lstat(join(this.directory, name)), false)) throw new Error("Unsafe cache temporary file");
          await unlink(join(this.directory, name)); continue;
        }
        if (!FILE.test(name)) continue;
        const raw = await this.read(name, MAX_ENTRY_BYTES);
        let old: unknown; try { old = raw ? JSON.parse(raw) : undefined; } catch { old = undefined; }
        if (name === `${key}.json` || !validate(old, name.slice(0, -5), epoch, this.now())) { await unlink(join(this.directory, name)); continue; }
        valid.push({ name, bytes: Buffer.byteLength(raw!), analysedAt: old.analysedAt });
      }
      valid.sort((a, b) => a.analysedAt - b.analysedAt || a.name.localeCompare(b.name));
      let bytes = valid.reduce((sum, e) => sum + e.bytes, 0);
      while (valid.length >= this.maxEntries || bytes + Buffer.byteLength(body) > this.maxBytes) {
        const oldest = valid.shift(); if (!oldest) break;
        await unlink(join(this.directory, oldest.name)); bytes -= oldest.bytes;
      }
      await this.atomic(`${key}.json`, body);
    });
  }
  /** Keep the private directory/generation; old in-flight writes cannot repopulate it. */
  async clear(): Promise<number> {
    if (!await this.directoryExists(false)) return 0;
    return this.locked(async () => {
      await this.atomic(".epoch", randomUUID());
      let removed = 0;
      for (const name of await readdir(this.directory)) {
        if (!FILE.test(name) && !/^\.tmp-[a-f0-9-]{36}$/.test(name)) continue;
        const s = await lstat(join(this.directory, name));
        // Unlinking a symlink/hardlink never follows its target. Even a corrupt
        // or broadly-permissioned cache entry can be explicitly erased safely.
        if (s.isDirectory() || s.uid !== process.getuid?.()) throw new Error("Unsafe cache file; clear refused");
        await unlink(join(this.directory, name)); if (FILE.test(name)) removed++;
      }
      return removed;
    });
  }
}

/** Resolve local executable/model identity without running or caching binary detection (3.4). */
async function fingerprint(path: string | undefined, executable = false): Promise<unknown> {
  if (!path) return undefined;
  const explicit = isAbsolute(path) || path.includes("/") || (process.platform === "win32" && path.includes("\\"));
  const pathEnv = process.env.PATH;
  if (executable && !explicit && pathEnv === undefined) throw new Error("Executable PATH is unavailable for cache identity");
  // Preserve symlink/.. traversal until realpath, just as binary detection and
  // processing do. Lexical resolve()/join() can fingerprint a different file.
  const extensions = process.platform === "win32" && !/\.(exe|com)$/i.test(path) ? ["", ".exe", ".com"] : [""];
  const candidates = executable && !explicit
    ? pathEnv!.split(delimiter).flatMap(part => extensions.map(ext => part ? `${part}${sep}${path}${ext}` : path + ext)) : [path];
  for (const candidate of candidates) {
    try {
      const target = await realpath(candidate), s = await stat(target, { bigint: true });
      if (executable) await access(target, constants.X_OK);
      if (s.isFile()) return [target, String(s.size), String(s.ino), String(s.mtimeNs), String(s.ctimeNs)];
    } catch (e) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
  }
  return ["missing", candidates];
}
function endpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Endpoint is unsuitable for cache identity");
  return url.href;
}
/** Full variant ladder/order plus policy, endpoint, local-file and algorithm identities. */
export async function cacheKey(input: ProcessVideoInput): Promise<string | undefined> {
  const { config: c, media, deps } = input;
  const variants = media.videoVariantsDetailed?.length
    ? media.videoVariantsDetailed.map(({ url, bitrate }) => ({ url, bitrate }))
    : (media.videoVariants ?? []).map(url => ({ url }));
  if (!variants.length || variants.some(v => !isAllowedMediaUrl(v.url) || [...new URL(v.url).searchParams.keys()].some(k => k !== "tag"))) return undefined;
  const ffmpeg = await fingerprint(c.ffmpegPath ?? "ffmpeg", true);
  const whisper = await fingerprint(c.whisperCppBinary, true);
  const model = await fingerprint(c.whisperModelPath), vad = await fingerprint(c.whisperVadModelPath);
  const identity = {
    schema: 1, processing: PROCESSING_VERSION,
    media: { type: media.type, id: media.id, duration: media.durationMillis, variants },
    video: { type: c.videoEndpointType, invalid: c.videoEndpointTypeInvalid === true, endpoint: endpoint(c.videoEndpoint ?? (c.videoEndpointType === "gemini-files" ? "https://generativelanguage.googleapis.com" : undefined)), authorized: c.videoEndpointExplicit, model: c.videoModel, keyEnv: c.videoApiKeyEnv, credentialAvailable: Boolean(deps.env?.[c.videoApiKeyEnv]) },
    stt: { endpoint: endpoint(c.sttEndpoint), model: c.sttModel, keyEnv: c.sttApiKeyEnv, credentialAvailable: Boolean(deps.env?.[c.sttApiKeyEnv]), language: c.sttLanguage },
    processingConfig: { seconds: c.maxVideoSeconds, bytes: c.maxVideoBytes, frames: c.maxFrames, budget: c.videoBudgetMs, enableImages: c.enableImageUnderstanding, enableVideo: c.enableVideoUnderstanding, enableProcessing: c.enableVideoProcessing, ffmpeg, whisper, model, vad, threads: c.whisperThreads, realtimeFactor: c.whisperRealtimeFactor },
    injectedPolicy: { inline: deps.inlineRawBytes, probeTimeout: deps.probeTimeoutMs, probeBudget: deps.probeBudgetMs },
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function containsCredential(e: Pick<VideoEvidence, "transcript" | "visualNotes">, input: ProcessVideoInput): boolean {
  return [input.config.videoApiKeyEnv, input.config.sttApiKeyEnv, "TWITTERAPI_IO_API_KEY"].some(name => {
    const value = input.deps.env?.[name];
    return typeof value === "string" && Boolean(value) && Boolean(e.transcript?.includes(value) || e.visualNotes?.includes(value));
  });
}

/** Optional metadata I/O can never retry/fail provider work. Caller cancellation still wins. */
export async function withEvidenceCache(input: ProcessVideoInput, run: () => Promise<VideoEvidence>): Promise<VideoEvidence> {
  const mode = input.config.evidenceCache ?? "off";
  if (mode === "off" || !input.config.enableVideoUnderstanding || !input.config.enableVideoProcessing) return run();
  const now = input.deps.now ?? Date.now;
  const active = () => { input.deps.signal?.throwIfAborted(); return now() < input.deadline; };
  const expired = (): VideoEvidence => ({ postUrl: input.postUrl, method: "frames-only", frames: [], notes: ["Video phase deadline expired before cached text could be delivered."] });
  if (!active()) return expired();
  const agentDir = input.deps.cacheAgentDir ?? getAgentDir();
  // Each metadata phase gets a FRESH timeout, bounded by the video's remaining
  // deadline. A lookup's timer must not expire during provider work and poison put.
  const cacheForIo = () => new TextEvidenceCache(agentDir, { now, signal: AbortSignal.any([
    ...(input.deps.signal ? [input.deps.signal] : []),
    AbortSignal.timeout(Math.max(1, Math.min(1_000, Math.ceil(input.deadline - now())))),
  ]) });
  const cache = cacheForIo();
  let key: string | undefined, epoch: string | undefined, unavailable = false;
  try {
    key = await cacheKey(input);
    if (!active()) return expired();
    if (key) {
      epoch = await cache.prepare(mode !== "read");
      if (!active()) return expired();
      if (epoch && mode !== "write") {
        const hit = await cache.get(key, epoch);
        if (!active()) return expired();
        if (hit && !containsCredential(hit, input)) {
          reportProgress(input.deps, "video: cached text evidence");
          if (!active()) return expired();
          return { postUrl: input.postUrl, method: hit.method, transcript: text(hit.transcript) ? hit.transcript : undefined, visualNotes: text(hit.visualNotes) ? hit.visualNotes : undefined, frames: [], notes: [
            `Cached text evidence reused from ${new Date(hit.analysedAt).toISOString()} (original method: ${hit.method}; clip limit: ${hit.clipSeconds}s). No media download or video/STT provider work was repeated.`,
            "Video frames/images were not restored from cache; original operational notes are not replayed.",
            ...(!text(hit.transcript) ? ["Cached text contains no transcript; speech was not recovered from this hit."] : []),
            ...(!text(hit.visualNotes) ? ["Cached text contains no visual description; only stored speech was reused."] : []),
          ] };
        }
      }
    }
  } catch { unavailable = true; }
  if (!active()) return expired();
  const evidence = await run();
  // Successful fallback speech is usable text; failed/empty/frame-only runs and
  // failed remote-upload cleanup are not reusable. Never retain raw error notes.
  if (!input.deps.signal?.aborted && active() && key && epoch && mode !== "read") {
    try {
      if (containsCredential(evidence, input)) evidence.notes.push("Video text contained a configured credential value; persistence was skipped.");
      else await cacheForIo().put(key, evidence, epoch, { clipSeconds: input.config.maxVideoSeconds });
    } catch { unavailable = true; }
  }
  if (unavailable) evidence.notes.push("Evidence cache was unavailable for part of this call; normal video processing continued.");
  return evidence;
}
