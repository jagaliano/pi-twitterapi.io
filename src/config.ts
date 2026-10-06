import type { PiSettings } from "./settings.js";
import { mergePiSettings } from "./settings.js";

import { DEFAULT_MAX_PAGES_CEILING } from "./twitterapi.js";

export const DEFAULT_MAX_MEDIA_PER_SEARCH = 4;
export const DEFAULT_MAX_PAGES = 5;
/**
 * Unpaid twitterapi.io accounts allow 0.2 QPS (one request every 5 seconds), so
 * this is the safest default both for pacing and for retry backoff. Paid tiers
 * can raise it.
 */
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 5_000;
export const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const MAX_INTERVAL_MS = 600_000;

/** Native-video wire formats. Both `gemini-files` and `openai-compatible` are implemented. */
export const VIDEO_ENDPOINT_TYPES = ["gemini-files", "openai-compatible", "anthropic"] as const;
export type VideoEndpointType = (typeof VIDEO_ENDPOINT_TYPES)[number];

export const DEFAULT_VIDEO_ENDPOINT_TYPE: VideoEndpointType = "gemini-files";
export const DEFAULT_VIDEO_API_KEY_ENV = "GOOGLE_API_KEY";
export const DEFAULT_STT_API_KEY_ENV = "STT_API_KEY";
export const DEFAULT_MAX_VIDEO_SECONDS = 120;
export const DEFAULT_MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const MAX_VIDEO_BYTES_CEILING = 64 * 1024 * 1024;
export const DEFAULT_MAX_FRAMES = 8;
export const DEFAULT_MAX_VIDEOS_PER_SEARCH = 1;
export const DEFAULT_VIDEO_BUDGET_MS = 180_000;
/**
 * Effective ceiling for the video phase (F8); larger configured values are clamped.
 *
 * Measured live: one `generateContent` over a 65 s clip took 32.7 s through the
 * Files path and ~71 s inline, varying run to run. The old 120 s ceiling aborted
 * long videos before the provider answered, so they fell back to the poster.
 */
export const MAX_VIDEO_BUDGET_MS = 300_000;

/**
 * Config keys that can execute code, choose an endpoint, or name a credential.
 * These are read from **user (global) settings only** — a project-level value is
 * ignored and disclosed, so a cloned repo cannot run a binary or exfiltrate a
 * secret via `.pi/settings.json`.
 */
export const USER_ONLY_CONFIG_KEYS = [
  "enableVideoProcessing",
  "videoEndpoint",
  "videoEndpointType",
  "videoModel",
  "videoApiKeyEnv",
  "sttEndpoint",
  "sttModel",
  "sttApiKeyEnv",
  "ffmpegPath",
  "whisperCppBinary",
  "whisperModelPath",
] as const;

export interface TwitterConfig {
  /**
   * pi model id ("provider/model") that synthesizes the answer from posts
   * retrieved via twitterapi.io. Resolved through pi's model catalogue. There is
   * no default: an unset value is a configuration error, reported before any
   * network work.
   */
  synthesisModel?: string;
  /** Attach image media to the synthesis request. */
  enableImageUnderstanding: boolean;
  /** Attach video poster frames to the synthesis request. */
  enableVideoUnderstanding: boolean;
  /**
   * Run real video processing (native video via the video endpoint, and/or
   * frames + STT). Requires `enableVideoUnderstanding`; off by default.
   */
  enableVideoProcessing: boolean;
  videoEndpointType: VideoEndpointType;
  /**
   * True when `twitter.videoEndpointType` held a non-empty string this loader does
   * not recognise. Native video is skipped in that case rather than falling back to a
   * default provider: a typo would otherwise send one provider's wire format to a host
   * the user configured for another. Frames and STT still run.
   *
   * Optional so that a caller-built `TwitterConfig` written before this field existed
   * still typechecks; the loader always supplies it, and the guard reads it as falsy
   * when absent.
   */
  videoEndpointTypeInvalid?: boolean;
  /** Base URL override. `gemini-files` defaults to Google; other hosts need an explicit endpoint + key env. */
  videoEndpoint?: string;
  /**
   * True only when this loader accepted `videoEndpoint` after the P0-1 checks
   * (explicit key env + https). The video adapter re-checks it so a programmatic
   * caller cannot hand-build a config that redirects the default key to another
   * host (P2-9).
   */
  videoEndpointExplicit: boolean;
  /** Native-video model id (e.g. "gemini-2.5-flash"). */
  videoModel?: string;
  /** Env var holding the native-video API key (default `GOOGLE_API_KEY`). */
  videoApiKeyEnv: string;
  /** OpenAI-compatible STT base URL. Unset disables remote STT. */
  sttEndpoint?: string;
  /** STT model id (e.g. "whisper-large-v3-turbo"). */
  sttModel?: string;
  /** Env var holding the STT API key (default `STT_API_KEY`). */
  sttApiKeyEnv: string;
  /** ISO-639-1 language for STT, or "auto" (default). */
  sttLanguage: string;
  /** ffmpeg binary override; otherwise PATH is searched. */
  ffmpegPath?: string;
  /** whisper.cpp binary (user-installed); unset disables the local STT tier. */
  whisperCppBinary?: string;
  /** whisper.cpp GGML model path (user-installed). */
  whisperModelPath?: string;
  /** Duration guard in seconds (default 120, max 600). */
  maxVideoSeconds: number;
  /** Byte cap for a single video download (default 32 MiB, max 64 MiB). */
  maxVideoBytes: number;
  /** Frames extracted per video (default 8, max 16). */
  maxFrames: number;
  /** Videos processed per search (default 1, max 3). */
  maxVideosPerSearch: number;
  /** Time budget for the video phase in ms (default 180_000, effective max 300_000). */
  videoBudgetMs: number;
  /** Notes about ignored/overridden settings, appended to result disclosures. */
  configNotes: string[];
  /** Upper bound on media attachments per search. */
  maxMediaPerSearch: number;
  /** Base page budget per search. */
  maxPages: number;
  /**
   * Hard ceiling on pages fetched in one search. `maxPages` is clamped to it, so
   * an explicit ceiling can never be exceeded.
   */
  maxPagesCeiling: number;
  /** Minimum spacing between upstream requests. */
  minRequestIntervalMs: number;
  /** Base delay for retry backoff. */
  retryBaseDelayMs: number;
}

export interface LoadTwitterConfigOptions {
  /**
   * Untrusted project settings. Only non-sensitive keys are read from here;
   * the `USER_ONLY_CONFIG_KEYS` are ignored with a disclosure. The first
   * argument is always treated as trusted (user) settings, so the one-argument
   * form keeps working for callers that have a single settings blob.
   */
  projectSettings?: PiSettings;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-negative finite milliseconds, clamped, or the fallback when absent/invalid. */
function intervalMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_INTERVAL_MS) : fallback;
}

/** Positive integer page count, clamped, or the fallback when absent/invalid. */
function pageCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, 100) : fallback;
}

/** Integer in [min, max], or the fallback when absent/invalid. */
function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function twitterBlock(settings: PiSettings | undefined): Record<string, unknown> {
  return settings && isObject(settings.twitter) ? settings.twitter : {};
}

export function loadTwitterConfig(settings: PiSettings, options: LoadTwitterConfigOptions = {}): TwitterConfig {
  const user = twitterBlock(settings);
  const project = twitterBlock(options.projectSettings);
  // Non-sensitive keys keep their historic behaviour: project overrides user.
  const config = mergePiSettings(user, project);
  const configNotes: string[] = [];

  // Sensitive keys are read from user settings only; a project-level value is
  // ignored and disclosed (B1/F1/F3).
  const ignored = USER_ONLY_CONFIG_KEYS.filter((key) => project[key] !== undefined);
  if (ignored.length > 0) {
    configNotes.push(
      `twitter.${ignored.join(", twitter.")} from project settings was ignored: executable paths, endpoints and ` +
        "credentials are read from user settings only.",
    );
  }

  const maxMedia = config.maxMediaPerSearch;
  const ceiling = pageCount(config.maxPagesCeiling, DEFAULT_MAX_PAGES_CEILING);
  const synthesisModel = text(config.synthesisModel);

  const enableVideoUnderstanding = config.enableVideoUnderstanding === true;
  const videoRequested = user.enableVideoProcessing === true;
  if (videoRequested && !enableVideoUnderstanding) {
    configNotes.push(
      "twitter.enableVideoProcessing was ignored because twitter.enableVideoUnderstanding is not enabled.",
    );
  }

  // Disclose an unrecognised provider string. The value still resolves to the default so
  // the rest of the config stays coherent, but native video is disabled for it (see
  // processVideo): guessing a provider would post one provider's wire format to a host
  // configured for another. Other unusable values in this loader are still silently
  // defaulted (numeric bounds clamp, non-strings are dropped).
  const endpointTypeRaw = text(user.videoEndpointType);
  const knownEndpointType = Boolean(
    endpointTypeRaw && (VIDEO_ENDPOINT_TYPES as readonly string[]).includes(endpointTypeRaw),
  );
  if (endpointTypeRaw && !knownEndpointType) {
    configNotes.push(
      `twitter.videoEndpointType "${endpointTypeRaw}" is not one of ${VIDEO_ENDPOINT_TYPES.join(", ")}; ` +
        "native video is disabled for this value, and no provider will be guessed for it.",
    );
  }
  const videoEndpointType: VideoEndpointType = knownEndpointType
    ? (endpointTypeRaw as VideoEndpointType)
    : DEFAULT_VIDEO_ENDPOINT_TYPE;
  const videoEndpointTypeInvalid = Boolean(endpointTypeRaw && !knownEndpointType);

  // F3/P0-1: a custom endpoint may only be used when the user ALSO names the
  // credential env var explicitly, and only over HTTPS. Otherwise the default
  // key (e.g. GOOGLE_API_KEY) could be sent to an arbitrary host.
  const explicitKeyEnv = text(user.videoApiKeyEnv);
  let videoEndpoint = text(user.videoEndpoint);
  if (videoEndpoint && !explicitKeyEnv) {
    configNotes.push(
      "twitter.videoEndpoint was ignored: set twitter.videoApiKeyEnv explicitly with a custom endpoint, so the " +
        "default key is never sent to another host.",
    );
    videoEndpoint = undefined;
  }
  if (videoEndpoint && !/^https:\/\//i.test(videoEndpoint)) {
    configNotes.push("twitter.videoEndpoint was ignored: it must be an https:// URL.");
    videoEndpoint = undefined;
  }

  return {
    synthesisModel,
    enableImageUnderstanding: config.enableImageUnderstanding === true,
    enableVideoUnderstanding,
    enableVideoProcessing: videoRequested && enableVideoUnderstanding,
    videoEndpointType,
    videoEndpointTypeInvalid,
    videoEndpoint,
    videoEndpointExplicit: Boolean(videoEndpoint && explicitKeyEnv),
    videoModel: text(user.videoModel),
    videoApiKeyEnv: explicitKeyEnv ?? DEFAULT_VIDEO_API_KEY_ENV,
    sttEndpoint: text(user.sttEndpoint),
    sttModel: text(user.sttModel),
    sttApiKeyEnv: text(user.sttApiKeyEnv) ?? DEFAULT_STT_API_KEY_ENV,
    sttLanguage: text(user.sttLanguage) ?? "auto",
    ffmpegPath: text(user.ffmpegPath),
    whisperCppBinary: text(user.whisperCppBinary),
    whisperModelPath: text(user.whisperModelPath),
    maxVideoSeconds: intInRange(config.maxVideoSeconds, DEFAULT_MAX_VIDEO_SECONDS, 1, 600),
    maxVideoBytes: intInRange(config.maxVideoBytes, DEFAULT_MAX_VIDEO_BYTES, 1_024, MAX_VIDEO_BYTES_CEILING),
    maxFrames: intInRange(config.maxFrames, DEFAULT_MAX_FRAMES, 1, 16),
    maxVideosPerSearch: intInRange(config.maxVideosPerSearch, DEFAULT_MAX_VIDEOS_PER_SEARCH, 1, 3),
    videoBudgetMs: Math.min(intervalMs(config.videoBudgetMs, DEFAULT_VIDEO_BUDGET_MS), MAX_VIDEO_BUDGET_MS),
    configNotes,
    maxMediaPerSearch:
      typeof maxMedia === "number" && Number.isInteger(maxMedia) && maxMedia >= 0
        ? Math.min(maxMedia, 20)
        : DEFAULT_MAX_MEDIA_PER_SEARCH,
    minRequestIntervalMs: intervalMs(config.minRequestIntervalMs, DEFAULT_MIN_REQUEST_INTERVAL_MS),
    retryBaseDelayMs: intervalMs(config.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS),
    maxPages: Math.min(pageCount(config.maxPages, DEFAULT_MAX_PAGES), ceiling),
    maxPagesCeiling: ceiling,
  };
}
