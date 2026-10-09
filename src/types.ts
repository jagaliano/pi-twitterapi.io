/**
 * Result shape shared by the format, synthesis and tool layers.
 *
 * `pi-twitterapi.io` returns an answer plus citation URLs: the retrieved posts
 * are synthesized into `text` and `citations` before being rendered.
 */
export interface TwitterSearchDetails {
  query: string;
  model: string;
  text: string;
  citations: string[];
  /** Legacy successful logical synthesis hops; usage.synthesisAttempts counts all SDK invocations. */
  synthesisCalls?: number;
  /** Measured per-run work; displayed only in Pi's expanded tool view. */
  usage?: TwitterUsage;
  timings?: TwitterTimings;
  /** Disclosures worth surfacing to the user; rendered as a trailing `## Notes` section. */
  notes?: string[];
}

export interface TwitterUsage {
  /** Actual fetch invocations, including retries; SDK-internal HTTP is not observable. */
  upstreamAttempts: number;
  upstreamHttpFailures: number;
  /** Accepted HTTP/JSON/semantic envelopes, including empty pages and single lookups. */
  successfulPages: number;
  /** Raw root-array entries (including duplicates/stubs) and timeline pin objects. */
  postsReturned: number;
  /** Root bundles actually delivered to synthesis, excluding nested context duplicates. */
  postsRetained: number;
  accountsReturned: number;
  accountsRetained: number;
  trendsReturned: number;
  trendsRetained: number;
  /** Actual media fetch invocations, including HEAD probes and GET downloads. */
  mediaAttempts: number;
  mediaHeadAttempts: number;
  /** HTTP non-2xx or fetch rejection, not subsequent body/admission/analysis failures. */
  mediaHttpFailures: number;
  /** All native lifecycle fetches (upload/poll/generate/delete), not logical videos. */
  nativeVideoAttempts: number;
  nativeVideoHttpFailures: number;
  sttAttempts: number;
  sttHttpFailures: number;
  /** Every registry.complete invocation, including reasoning repair and fallback/retry. */
  synthesisAttempts: number;
  synthesisFailures: number;
  /** SDK-reported samples only, including failed messages; absent fields remain unknown. */
  synthesisTokens?: { reportedCalls: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
}

export interface TwitterTimings {
  /** Backend preflight through assembled result; excludes settings reload and UI/markdown formatting. */
  totalMs: number;
  /** Includes preflight, API pacing/retries, body reads and retrieval mapping. */
  retrievalMs: number;
  /** Includes input selection, media/video preparation and final citation/disclosure processing. */
  preprocessingMs: number;
  /** Full synthesis chain, including repair, fallback and retry backoff. */
  synthesisMs: number;
  /** Explicitly NESTED in preprocessingMs; NEVER add to the three disjoint phases above. */
  videoMs: number;
}
