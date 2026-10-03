import type { NormalizedSearchParams, TwitterApiSearchParams } from "./core.js";

const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;

function normalizeHandles(handles: string[] | undefined, field: string): string[] {
  if (!handles) return [];
  if (handles.length > 20) throw new Error(`twitter ${field} accepts at most 20 handles (got ${handles.length})`);
  return handles.map((handle) => {
    const match = HANDLE_RE.exec(handle.trim());
    if (!match) throw new Error(`twitter ${field} must be valid X handles without spaces (got "${handle}")`);
    return match[1];
  });
}

function normalizeDate(date: string | undefined, field: string): string | undefined {
  if (!date) return undefined;
  const trimmed = date.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) throw new Error(`twitter ${field} must be YYYY-MM-DD (got "${date}")`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new Error(`twitter ${field} is not a real calendar date (got "${date}")`);
  }
  return trimmed;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function normalizeParams(params: TwitterApiSearchParams): NormalizedSearchParams {
  const query = params.query?.trim();
  if (!query) throw new Error("twitter query must not be empty");

  const allowed = normalizeHandles(params.allowed_x_handles, "allowed_x_handles");
  const excluded = normalizeHandles(params.excluded_x_handles, "excluded_x_handles");
  if (allowed.length > 0 && excluded.length > 0) {
    throw new Error("twitter allowed_x_handles and excluded_x_handles cannot be set together");
  }

  const fromDate = normalizeDate(params.from_date, "from_date");
  const toDate = normalizeDate(params.to_date, "to_date");
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("twitter from_date must be before or equal to to_date");
  }

  const count = params.count ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error("twitter count must be an integer between 1 and 50");
  }

  const queryType = params.queryType ?? "Latest";
  if (queryType !== "Latest" && queryType !== "Top") {
    throw new Error('twitter queryType must be "Latest" or "Top"');
  }

  return { query, allowed_x_handles: allowed, excluded_x_handles: excluded, from_date: fromDate, to_date: toDate, queryType, count };
}

/** Build the X advanced-search expression sent to twitterapi.io. */
export function buildExpression(params: NormalizedSearchParams): string {
  const constraints: string[] = [];
  if (params.allowed_x_handles?.length) {
    constraints.push(params.allowed_x_handles.length === 1
      ? `from:${params.allowed_x_handles[0]}`
      : `(${params.allowed_x_handles.map((h) => `from:${h}`).join(" OR ")})`);
  }
  if (params.excluded_x_handles?.length) {
    for (const h of params.excluded_x_handles) constraints.push(`-from:${h}`);
  }
  if (params.from_date) constraints.push(`since:${params.from_date}`);
  if (params.to_date) constraints.push(`until:${params.to_date}`);
  // Group the user query so appended AND-constraints cannot leak into
  // an OR branch (e.g. `cats OR dogs` + handle must not leave `cats` unscoped).
  if (constraints.length === 0) return params.query;
  return `(${params.query}) ${constraints.join(" ")}`;
}

