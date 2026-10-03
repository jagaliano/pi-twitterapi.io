import type { PiSettings } from "./settings.js";

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

export function loadTwitterConfig(settings: PiSettings): TwitterConfig {
  const config = isObject(settings.twitter) ? settings.twitter : {};
  const maxMedia = config.maxMediaPerSearch;
  const ceiling = pageCount(config.maxPagesCeiling, DEFAULT_MAX_PAGES_CEILING);
  const synthesisModel =
    typeof config.synthesisModel === "string" && config.synthesisModel.trim()
      ? config.synthesisModel.trim()
      : undefined;
  return {
    synthesisModel,
    enableImageUnderstanding: config.enableImageUnderstanding === true,
    enableVideoUnderstanding: config.enableVideoUnderstanding === true,
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
