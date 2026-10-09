import { reportProgress, type ProgressCallback } from "../progress.js";
import type { TwitterSearchDetails } from "../types.js";
import { SYNTHESIS_SYSTEM_PROMPT, type SynthesisRequest } from "../synthesize.js";
import { InputBudget, renderedPrompt, withoutImages } from "../input-budget.js";
import {
  assistantText,
  availableModels,
  resolveModel,
  type ModelLike,
  type RegistryLike,
  type TwitterApiSynthesisOptions,
} from "./model.js";

/**
 * Validate a completion result before its text is treated as an answer.
 *
 * `ModelRegistry.complete` resolves with the assistant message even when the
 * provider reported a failure, so an unchecked result turns an error into an
 * empty-but-successful answer. Anything other than a normal stop must fail here
 * rather than reach the user as a blank answer with real sources attached.
 */
export function completionText(message: unknown): string {
  const record = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
  const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
  const detail = typeof record.errorMessage === "string" && record.errorMessage ? `: ${record.errorMessage}` : "";
  if (stopReason === "error") throw new Error(`twitter synthesis failed${detail}`);
  if (stopReason === "aborted") throw new Error("twitter synthesis was cancelled before it produced an answer");
  if (stopReason === "toolUse") throw new Error("twitter synthesis tried to call a tool instead of answering");
  const text = assistantText(message);
  if (!text) {
    throw new Error(
      stopReason === "length"
        ? "twitter synthesis hit the model's output limit before producing any text"
        : "twitter synthesis returned an empty answer",
    );
  }
  return text;
}


/** The only efforts a provider can legitimately name for a reasoning model. */
const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Recover the cheapest accepted reasoning effort from a provider rejection.
 *
 * Some models cannot be called with reasoning off at all — pi sends
 * `reasoning_effort: 'none'` by default, and an `openai-responses` model that
 * requires reasoning answers 400 with the accepted list. Retrying once with the
 * first supported value keeps such models usable instead of failing synthesis
 * (measured live against `opencode-go/muse-spark-1.3-contributor`).
 *
 * The rejection and the list must belong to the *same* sentence mentioning the
 * reasoning effort, and the recovered value must be a real effort name: an
 * unrelated 400 that happens to list its own values (for example
 * `Invalid response_format. Supported values: [json, text]`) must not trigger a
 * repair that would mask the original cause.
 */
export function supportedReasoningEffort(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const rejected = /reasoning[_ ]effort[^.;]{0,120}?(?:not supported|unsupported|invalid)/i.test(message)
    || /(?:not supported|unsupported|invalid)[^.;]{0,120}?reasoning[_ ]effort/i.test(message);
  if (!rejected) return undefined;
  const list = /supported values?:?\s*\[([^\]]+)\]/i.exec(message)?.[1];
  if (!list) return undefined;
  return list
    .split(",")
    .map((value) => value.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .find((value) => (REASONING_EFFORTS as readonly string[]).includes(value));
}

/**
 * Build the synthesis completion for a resolved model. Shared by every
 * twitterapi.io path so failure handling cannot differ between them.
 */
function createCompletion(
  registry: RegistryLike,
  run: NonNullable<RegistryLike["complete"]>,
  model: ModelLike,
  budget: InputBudget,
  progress?: ProgressCallback,
): (request: SynthesisRequest) => Promise<string> {
  return async (request) => {
    budget.assert(request, model);
    const promptText = renderedPrompt(request);
    const attempt = (reasoningEffort?: string): Promise<unknown> => {
      budget.assert(request, model);
      reportProgress({ progress, signal: request.signal }, `synthesizing with ${model.provider}/${model.id}`);
      return run.call(
        registry,
        model as never,
        {
          systemPrompt: request.system,
          messages: [
            {
              role: "user",
              content:
                request.images.length > 0
                  ? [
                      { type: "text", text: promptText },
                      ...request.images.map((image) => ({
                        type: "image",
                        data: image.data,
                        mimeType: image.mimeType,
                      })),
                    ]
                  : request.prompt,
              timestamp: Date.now(),
            },
          ],
        } as never,
        { signal: request.signal, maxTokens: budget.outputTokens, ...(reasoningEffort ? { reasoningEffort } : {}) } as never,
      );
    };
    try {
      return completionText(await attempt());
    } catch (error) {
      // Authoritative cancellation wins: never spend another registry call on a
      // repair after the caller has gone away (P2-2).
      if (classifySynthesisError(error, request.signal) === "cancelled") throw error;
      const effort = supportedReasoningEffort(error);
      if (!effort) throw error;
      return completionText(await attempt(effort));
    }
  };
}

export interface SynthesisBackend {
  fetcher: typeof fetch;
  apiKey: string;
  model: ModelLike;
  budget: InputBudget;
  /** Ready-to-use synthesis completion, with fallback and failure handling applied. */
  complete: (request: SynthesisRequest) => Promise<string>;
  /** Model that served the most recent completion after the primary failed. */
  fallback?: ModelLike;
  /** True when the most recent completion was served by the fallback model. */
  isFallbackUsed: () => boolean;
  /** True when images were dropped because the answering model cannot take them. */
  imagesDropped: () => boolean;
}

/** True for an aborted/cancelled completion, which must not trigger a fallback. */
export type SynthesisFailureKind =
  | "cancelled"
  | "quota"
  | "auth"
  | "unknown-model"
  | "invalid-request"
  | "rate-limit"
  | "server"
  | "transport"
  | "empty"
  | "unknown";

/**
 * Failure classes worth one retry on the last model. Deterministic failures
 * (quota, auth, unknown model, invalid request, and anything unclassified) are
 * never retried: a second attempt cannot succeed or is not worth a second billed
 * call.
 */
const RETRYABLE_ON_LAST: ReadonlySet<SynthesisFailureKind> = new Set([
  "rate-limit",
  "server",
  "transport",
  "empty",
]);

const LAST_MODEL_RETRY_BASE_MS = 500;
const LAST_MODEL_RETRY_CAP_MS = 4_000;

/** Bounded exponential backoff: 500 ms, doubling to a 4 s cap. */
export function synthesisRetryDelayMs(attempt: number): number {
  return Math.min(LAST_MODEL_RETRY_BASE_MS * 2 ** attempt, LAST_MODEL_RETRY_CAP_MS);
}

/**
 * Classify a synthesis failure so the chain reacts per kind instead of treating
 * every error alike.
 *
 * Cancellation is authoritative from the signal or error type; the text match is
 * only a fallback for pi's own "was cancelled" wording, so a provider message
 * like "connection aborted" is a transport failure rather than a caller cancel.
 * Explicit status codes are checked before text heuristics, so a 429 carrying
 * quota wording is still a rate limit and an `api key` mention cannot turn a rate
 * limit into an auth failure.
 */
export function classifySynthesisError(error: unknown, signal?: AbortSignal): SynthesisFailureKind {
  const name = error instanceof Error ? error.name : "";
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (signal?.aborted || name === "AbortError" || /\bwas cancelled\b|generation was cancelled/.test(message)) {
    return "cancelled";
  }
  if (/\b429\b/.test(message)) {
    return /insufficient_quota|billing|payment required/.test(message) ? "quota" : "rate-limit";
  }
  if (/\b402\b/.test(message)) return "quota";
  if (/\b401\b|\b403\b/.test(message)) return "auth";
  if (/\b404\b/.test(message)) return "unknown-model";
  if (/\b400\b|\b422\b/.test(message)) return "invalid-request";
  if (/\b5\d\d\b/.test(message)) return "server";
  if (/insufficient_quota|quota|billing|payment required|subscription|\bcredits?\b/.test(message)) return "quota";
  if (/unauthor|invalid api key|forbidden|authentication|\bapi key\b/.test(message)) return "auth";
  if (/does not exist|unknown model|no such model|not found/.test(message)) return "unknown-model";
  if (/malformed|invalid request|bad request|validation|tried to call a tool|context length|too long|token limit/.test(message)) {
    return "invalid-request";
  }
  if (/too many requests|rate limit|overloaded/.test(message)) return "rate-limit";
  if (/bad gateway|unavailable|internal server error|gateway timeout/.test(message)) return "server";
  if (
    /timeout|timed out|econnreset|econnrefused|enotfound|socket hang up|network|fetch failed|premature|stream ended|\babort(ed)?\b|connection (closed|drop|lost|reset)/.test(
      message,
    )
  ) {
    return "transport";
  }
  if (/empty answer|no usable text|output limit|empty response/.test(message)) return "empty";
  // Unclassified failures are deterministic here: an unrecognised error is not
  // worth a second billed call.
  return "unknown";
}

/** Resolve after `ms`, or reject when the caller aborts. */
function synthesisDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("twitter synthesis was cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("twitter synthesis was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Disclose the fallback model and any dropped images on the result. */
export function applyFallbackNote(backend: SynthesisBackend, details: TwitterSearchDetails): void {
  const fallback = backend.fallback;
  if (backend.isFallbackUsed() && fallback) {
    details.model = `${fallback.provider}/${fallback.id}`;
    details.notes = [
      ...(details.notes ?? []),
      `The configured synthesis model failed; the answer was produced by ${fallback.provider}/${fallback.id}.`,
    ];
  }
  if (backend.imagesDropped()) {
    details.notes = [
      ...(details.notes ?? []),
      "The model that answered does not accept image input or lacks declared image bounds, so attached images were omitted, along with their references.",
    ];
  }
}

/**
 * Shared preflight: credentials, the synthesis model, and its completion. Runs
 * before any network work so a misconfiguration fails immediately and says why.
 */
export function resolveSynthesisBackend(options: TwitterApiSynthesisOptions, query?: string): SynthesisBackend {
  const fetcher = options.fetcher ?? fetch;
  const apiKey = options.env?.TWITTERAPI_IO_API_KEY;
  if (!apiKey) {
    throw new Error("TWITTERAPI_IO_API_KEY must be configured to use the twitterapi.io backend.");
  }
  const registry = options.registry;
  if (!registry) {
    throw new Error("twitter could not reach pi's model registry, which the twitterapi.io backend needs for synthesis.");
  }

  // `complete` is not present on every supported pi version, so it is detected
  // here instead of being assumed (verified absent on pi 0.80.6, present on 0.99.2).
  const run = registry.complete;
  if (typeof run !== "function") {
    throw new Error(
      "the twitterapi.io backend needs pi's ModelRegistry.complete, which this pi version does not provide " +
        "(verified absent on pi 0.80.6, present on 0.99.2). Upgrade pi to a version that provides it.",
    );
  }

  const synthesisModelId = options.config.synthesisModel;
  if (!synthesisModelId) {
    throw new Error(
      "twitter needs a synthesis model: set twitter.synthesisModel to a model id from pi's catalogue, " +
        "or call it from a session whose active model is resolvable.",
    );
  }
  const model = resolveModel(registry, synthesisModelId);
  if (!model) {
    const slash = synthesisModelId.indexOf("/");
    const provider = slash > 0 ? synthesisModelId.slice(0, slash) : undefined;
    const available = availableModels(registry.getAll(), provider);
    throw new Error(
      `twitter synthesis model "${synthesisModelId}" was not found in pi's model catalogue. ` +
        (available ? `Known models${provider ? ` for "${provider}"` : ""}: ${available}. ` : "") +
        "Set twitter.synthesisModel to a model id from pi's catalogue.",
    );
  }
  // Build the model chain: the configured model first, then any caller-supplied
  // fallbacks (typically the session model), deduplicated.
  const chain: ModelLike[] = [model];
  for (const id of options.fallbackModelIds ?? []) {
    if (!id) continue;
    const resolved = resolveModel(registry, id);
    if (!resolved) continue;
    if (chain.some((entry) => entry.provider === resolved.provider && entry.id === resolved.id)) continue;
    chain.push(resolved);
  }

  const budget = new InputBudget(chain, options.config.maxSynthesisChars, options.config.imageInputBounds);
  if (query !== undefined) budget.preflight(query, SYNTHESIS_SYSTEM_PROMPT);
  const completions = new Map<ModelLike, (request: SynthesisRequest) => Promise<string>>();
  let imagesDropped = false;
  const completionFor = (target: ModelLike): ((request: SynthesisRequest) => Promise<string>) => {
    let completion = completions.get(target);
    if (!completion) {
      const completeModel = createCompletion(registry, run, target, budget, options.progress);
      const supportsImage = budget.acceptsImages(target);
      completion = supportsImage
        ? completeModel
        : async (request) => {
            // A fallback that cannot take images must not receive them: a vision
            // primary can fail and hand images to a text-only session model.
            if (request.images.length > 0 || request.mediaManifest) {
              imagesDropped = true;
              return completeModel(withoutImages(request));
            }
            return completeModel(request);
          };
      completions.set(target, completion);
    }
    return completion;
  };

  let fallback: ModelLike | undefined;
  const sleepForRetry = options.synthesisSleep ?? synthesisDelay;

  const complete = async (input: SynthesisRequest): Promise<string> => {
    const request = { ...input, maxTokens: budget.outputTokens };
    // Reset per call so a run that completes more than once never mislabels the
    // answering model from an earlier call.
    fallback = undefined;
    imagesDropped = false;
    const failures: string[] = [];
    for (let index = 0; index < chain.length; index += 1) {
      const candidate = chain[index];
      // An untried model is the better bet than retrying a model that already
      // failed, so the retry budget is only spent on the last model in the chain.
      const isLast = index === chain.length - 1;
      const maxAttempts = isLast ? 2 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (attempt > 0) {
          // attempt 1 only happens on the last model after a retryable class.
          await sleepForRetry(synthesisRetryDelayMs(attempt - 1), request.signal);
        }
        try {
          const text = await completionFor(candidate)(request);
          if (index > 0) fallback = candidate;
          return text;
        } catch (error) {
          const kind = classifySynthesisError(error, request.signal);
          // A cancellation stops the chain: it is the caller's intent, not a
          // model failure to route around.
          if (kind === "cancelled") throw error;
          failures.push(`${candidate.provider}/${candidate.id} (${kind}): ${error instanceof Error ? error.message : String(error)}`);
          if (!isLast || !RETRYABLE_ON_LAST.has(kind)) break;
        }
      }
    }
    // Every model's cause is reported, not just the last one.
    throw new Error(`twitter synthesis failed: ${failures.join("; ")}`);
  };

  // `fallback` is resolved lazily: the completion runs after this object is
  // built, so a plain property would freeze the pre-run value (undefined).
  const backend: SynthesisBackend = {
    fetcher,
    apiKey,
    model,
    budget,
    complete,
    get fallback(): ModelLike | undefined {
      return fallback;
    },
    isFallbackUsed: () => fallback !== undefined,
    imagesDropped: () => imagesDropped,
  };
  return backend;
}

