import type { TwitterTimings, TwitterUsage } from "./types.js";

type Phase = "retrievalMs" | "preprocessingMs" | "synthesisMs";
type RequestKind = "upstream" | "media" | "nativeVideo" | "stt";
const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One run, never shared by credential/model. Counts actual injected I/O invocations. */
export class RunTelemetry {
  readonly usage: TwitterUsage = {
    upstreamAttempts: 0, upstreamHttpFailures: 0, successfulPages: 0,
    postsReturned: 0, postsRetained: 0, accountsReturned: 0, accountsRetained: 0, trendsReturned: 0, trendsRetained: 0,
    mediaAttempts: 0, mediaHeadAttempts: 0, mediaHttpFailures: 0,
    nativeVideoAttempts: 0, nativeVideoHttpFailures: 0, sttAttempts: 0, sttHttpFailures: 0,
    synthesisAttempts: 0, synthesisFailures: 0,
  };
  private readonly elapsed = { retrievalMs: 0, preprocessingMs: 0, synthesisMs: 0 };
  private current: Phase = "retrievalMs";
  private at: number;
  private videoMs = 0;

  constructor(readonly now: () => number = () => performance.now()) { this.at = now(); }

  phase(next: Phase): void {
    const now = this.now();
    this.elapsed[this.current] += Math.max(0, now - this.at);
    this.at = now;
    this.current = next;
  }

  addVideoTime(start: number): void { this.videoMs += Math.max(0, this.now() - start); }

  fetcher(fetcher: typeof fetch, kind: RequestKind): typeof fetch {
    return async (input, init) => {
      this.usage[`${kind}Attempts`]++;
      if (kind === "media" && (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() === "HEAD") this.usage.mediaHeadAttempts++;
      try {
        const response = await fetcher(input, init);
        if (!response.ok) this.usage[`${kind}HttpFailures`]++;
        return response;
      } catch (error) {
        this.usage[`${kind}HttpFailures`]++;
        throw error;
      }
    };
  }

  /** Accepted HTTP/JSON/semantic envelopes, before mapping, filtering or target cutoffs. */
  page(body: Record<string, unknown>): void {
    this.usage.successfulPages++;
    const data = object(body.data) ? body.data : body;
    const tweets = body.tweets ?? data.tweets;
    if (Array.isArray(tweets)) {
      this.usage.postsReturned += tweets.length;
      const pin = body.pin_tweet ?? data.pin_tweet;
      if (object(pin)) this.usage.postsReturned++;
    }
    const users = body.users ?? body.followers ?? body.followings ?? data.users;
    if (Array.isArray(users)) this.usage.accountsReturned += users.length;
    else if (typeof data.userName === "string" || typeof data.screen_name === "string" || typeof data.username === "string") this.usage.accountsReturned++;
    if (Array.isArray(body.trends)) this.usage.trendsReturned += body.trends.length;
  }

  /** Keep provider-reported fields only; missing reports are not fabricated zeroes. */
  tokens(message: unknown): void {
    const fields: Partial<Record<typeof tokenFields[number], number>> = {};
    try {
      const usage = object(message) ? message.usage : undefined;
      if (!object(usage)) return;
      for (const key of tokenFields) {
        const value = usage[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) fields[key] = value;
      }
    } catch { return; } // Optional metadata must never fail or retry paid synthesis.
    if (Object.keys(fields).length === 0) return;
    const total = this.usage.synthesisTokens ??= { reportedCalls: 0 };
    total.reportedCalls++;
    for (const key of tokenFields) {
      const value = fields[key];
      if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
  }

  snapshot(): { usage: TwitterUsage; timings: TwitterTimings } {
    const elapsed = { ...this.elapsed };
    elapsed[this.current] += Math.max(0, this.now() - this.at);
    return {
      usage: { ...this.usage, ...(this.usage.synthesisTokens ? { synthesisTokens: { ...this.usage.synthesisTokens } } : {}) },
      timings: { totalMs: elapsed.retrievalMs + elapsed.preprocessingMs + elapsed.synthesisMs, ...elapsed, videoMs: this.videoMs },
    };
  }
}
