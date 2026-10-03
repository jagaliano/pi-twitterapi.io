import type { LocalWindow, NormalizedSearchParams } from "./core.js";

/**
 * twitterapi.io evaluates X `since:` / `until:` day boundaries at 04:00 UTC
 * (verified empirically: `until:2026-09-25` returned tweets up to
 * 2026-09-26T03:59:59Z, i.e. a UTC-4 day boundary rather than UTC midnight).
 * Time-of-day components (`until:2026-09-29_12:00:00_UTC`) are not honored.
 *
 * Consequences for local calendar days (offset = local - UTC):
 *  - start: the upstream bound may fall after the local one, so pad `since:`
 *    backwards by the whole days needed. Padding the start only adds older
 *    tweets to the tail of a newest-first scan, which is harmless.
 *  - end: the upstream bound may fall before the local one, leaving a gap of
 *    max(0, -offset - 4) hours at the end of the day. We deliberately do NOT
 *    pad `until:` forward: that pushes a full extra day of newer tweets ahead
 *    of the requested range and starves `count` on any busy topic (observed:
 *    0 results for a single local day).
 */
/**
 * Hour (UTC) at which twitterapi.io resolves `since:`/`until:` day boundaries.
 * Probed in September, when US Eastern is UTC-4, so a fixed 04:00Z and New York
 * local midnight are indistinguishable. Start padding therefore adds one extra
 * hour (see {@link UPSTREAM_START_PAD_HOURS}): over-padding only adds older tail
 * posts that are trimmed client-side, while under-padding would silently drop
 * the first hour of the local day if the boundary is really 05:00Z in winter.
 */
export const UPSTREAM_BOUNDARY_UTC_HOUR = 4;
/** Conservative start-padding boundary; see {@link UPSTREAM_BOUNDARY_UTC_HOUR}. */
export const UPSTREAM_START_PAD_HOURS = UPSTREAM_BOUNDARY_UTC_HOUR + 1;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

function wallClockAsUtc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d, 0, 0, 0);
}

/**
 * UTC instant at which a local calendar day begins, resolved against the host
 * timezone.
 *
 * Rather than trusting one offset probe, both plausible offsets (well before and
 * well after the boundary) are turned into candidate instants, each candidate is
 * checked for actually reading as the target local date, and the earliest valid
 * one wins. A single probe is not enough: transitions happen at local midnight in
 * some zones (America/Sao_Paulo) and at 02:00/03:00 in others
 * (Australia/Sydney, America/New_York), so any fixed probe distance is wrong for
 * one of those shapes. Validating candidates also gives the correct answers when
 * local midnight does not exist (spring forward) or happens twice (fall back).
 */
function hostLocalMidnightUtc(y: number, m: number, d: number): number {
  const wall = wallClockAsUtc(y, m, d);
  const dayIndex = Math.floor(wall / MS_PER_DAY);
  const probeOffsets = [
    new Date(wall - 12 * MS_PER_HOUR).getTimezoneOffset() * 60_000,
    new Date(wall + 12 * MS_PER_HOUR).getTimezoneOffset() * 60_000,
  ];
  const candidates = [...new Set(probeOffsets)].map((offset) => wall + offset).sort((a, b) => a - b);

  for (const candidate of candidates) {
    const localWall = candidate - new Date(candidate).getTimezoneOffset() * 60_000;
    if (Math.floor(localWall / MS_PER_DAY) === dayIndex) return candidate;
  }
  // Both candidates land on another local day: the requested day is unreachable
  // (a whole skipped day), so the earliest candidate is the closest boundary.
  return candidates[0];
}

function fixedLocalMidnightUtc(y: number, m: number, d: number, offsetMinutes: number): number {
  return wallClockAsUtc(y, m, d) - offsetMinutes * 60_000;
}

function parseDateParts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function addDaysToDate(date: string, days: number): [number, number, number] {
  const [y, m, d] = parseDateParts(date);
  const shifted = new Date(wallClockAsUtc(y, m, d) + days * MS_PER_DAY);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()];
}

/**
 * Latest upstream `since:` date whose 04:00 UTC boundary is at or before the
 * window start, so the requested window is always covered.
 */
export function upstreamStartDateString(startMs: number): string {
  return new Date(startMs - UPSTREAM_START_PAD_HOURS * MS_PER_HOUR).toISOString().slice(0, 10);
}

/** UTC instant where the upstream `until:` bound for a date stops returning posts. */
export function upstreamEndMs(toDate: string): number {
  const [y, m, d] = addDaysToDate(toDate, 1);
  return wallClockAsUtc(y, m, d) + UPSTREAM_BOUNDARY_UTC_HOUR * MS_PER_HOUR;
}

function shiftDateString(date: string, days: number): string {
  const [y, m, d] = addDaysToDate(date, days);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const X_DATE_RE = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/;
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Parse X's `Thu Oct 01 04:02:43 +0000 2026` (and ISO-8601) into epoch ms. */
export function parseTweetDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = X_DATE_RE.exec(value.trim());
  if (match) {
    const month = MONTHS[match[1]];
    if (month === undefined) return undefined;
    const [, , day, hour, minute, second, offset, year] = match;
    const sign = offset.startsWith("-") ? -1 : 1;
    const offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
    const utc = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second));
    return utc - offsetMinutes * 60_000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}


/**
 * Resolve `from_date` / `to_date` (local calendar days) into a UTC window.
 * One-sided filters stay one-sided: an absent bound is left unbounded.
 * Passing an explicit `localUtcOffsetMinutes` selects fixed-offset mode;
 * otherwise each boundary uses the host's offset at that date (DST-correct).
 */
export function resolveLocalWindow(
  params: NormalizedSearchParams,
  localUtcOffsetMinutes?: number,
): LocalWindow | undefined {
  if (!params.from_date && !params.to_date) return undefined;
  const fixed = localUtcOffsetMinutes !== undefined;
  const midnight = (date: string): number => {
    const [y, m, d] = parseDateParts(date);
    return fixed
      ? fixedLocalMidnightUtc(y, m, d, localUtcOffsetMinutes)
      : hostLocalMidnightUtc(y, m, d);
  };

  const startMs = params.from_date ? midnight(params.from_date) : Number.NEGATIVE_INFINITY;
  const endMs = params.to_date ? midnight(shiftDateString(params.to_date, 1)) : Number.POSITIVE_INFINITY;

  let zone: string;
  if (fixed) {
    const sign = localUtcOffsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(localUtcOffsetMinutes);
    zone = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")} (fixed)`;
  } else {
    const reference = Number.isFinite(startMs) ? startMs : endMs;
    const offsetMinutes = -new Date(reference).getTimezoneOffset();
    const sign = offsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(offsetMinutes);
    zone = `host timezone, UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")} at window ${Number.isFinite(startMs) ? "start" : "end"}`;
  }

  const shortfallHours = params.to_date ? Math.max(0, (endMs - upstreamEndMs(params.to_date)) / MS_PER_HOUR) : 0;
  const trimHours = params.to_date ? Math.max(0, (upstreamEndMs(params.to_date) - endMs) / MS_PER_HOUR) : 0;

  return {
    startMs,
    endMs,
    fromDate: params.from_date,
    toDate: params.to_date,
    zone,
    shortfallHours,
    trimHours,
  };
}

/**
 * Pad the upstream `since:` back so the requested window start is always
 * covered. The `until:` bound is never padded forward: that would push a full
 * extra day of newer posts ahead of the range and starve `count` on busy topics.
 */
export function withPaddedStart(params: NormalizedSearchParams, window: LocalWindow | undefined): NormalizedSearchParams {
  if (!params.from_date || !window || !Number.isFinite(window.startMs)) return params;
  const padded = upstreamStartDateString(window.startMs);
  return padded === params.from_date ? params : { ...params, from_date: padded };
}
