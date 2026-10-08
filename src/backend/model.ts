import type { TwitterConfig } from "../config.js";
import type { BudgetModel } from "../input-budget.js";
import type { SynthesisModel } from "../synthesize.js";
import type { ExecFn } from "./video.js";

/**
 * Minimal structural view of pi's ModelRegistry, so this module stays testable
 * without importing pi internals.
 *
 * Only `find` and `getAll` are required: they exist across the supported pi
 * range. `complete` does NOT — pi 0.80.6 has no such member (verified in both
 * its .d.ts and compiled JS), so it is optional here and feature-detected at
 * call time rather than assumed. Keeping it optional is what lets the real
 * ModelRegistry be passed without a cast, so a future signature change fails
 * typecheck instead of silently breaking at runtime.
 */
export interface RegistryLike {
  find(provider: string, modelId: string): ModelLike | undefined;
  getAll(): readonly ModelLike[];
  complete?(model: never, context: never, options?: never): Promise<unknown>;
}

export interface ModelLike extends BudgetModel {
  provider: string;
  id: string;
  input?: readonly string[];
}
/** Options shared by every twitterapi.io run path. */
export interface BackendOptions {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  registry?: RegistryLike;
  signal?: AbortSignal;
  /**
   * Models to try, in order, after the configured synthesis model fails at
   * runtime (typically the model running the current session). Duplicates of the
   * primary and of each other are dropped.
   */
  fallbackModelIds?: string[];
  /** Override the retry delay between last-model attempts (tests). */
  synthesisSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected local-process runner for video processing (tests). */
  videoExec?: ExecFn;
}

/** Resolve a `provider/model` spec, or a bare model id, against the registry. */
export function resolveModel(registry: RegistryLike, spec: string): ModelLike | undefined {
  const known = registry.getAll();
  const slash = spec.indexOf("/");
  const provider = slash > 0 ? spec.slice(0, slash) : undefined;
  const id = slash > 0 ? spec.slice(slash + 1) : spec;
  const scope = known.filter((model) => provider === undefined || model.provider === provider);
  const describe = (models: ModelLike[]): string => models.map((model) => `${model.provider}/${model.id}`).join(", ");

  const exact = scope.filter((model) => model.id === id);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(
      `twitter model "${spec}" is ambiguous across providers (${exact.map((model) => model.provider).join(", ")}); ` +
        'configure it as "provider/model" in the twitter settings block.',
    );
  }

  // A provider may namespace its own ids, so a model the catalogue calls
  // `<vendor>/<model>` is accepted by pi's `--model` as `provider/<model>`. An id
  // matching one namespaced model is therefore a valid short form, not a typo.
  const suffixed = scope.filter((model) => model.id.endsWith(`/${id}`));
  if (suffixed.length === 1) return suffixed[0];
  if (suffixed.length > 1) {
    throw new Error(
      `twitter model "${spec}" matches several models (${describe(suffixed)}); write the full model id.`,
    );
  }
  return undefined;
}

/** Model ids a provider exposes, so a "not found" error can be acted on. */
export function availableModels(known: readonly ModelLike[], provider: string | undefined): string {
  const ids = known
    .filter((model) => provider === undefined || model.provider === provider)
    .map((model) => `${model.provider}/${model.id}`)
    .sort();
  const shown = ids.slice(0, 8);
  return ids.length > shown.length ? `${shown.join(", ")}, and ${ids.length - shown.length} more` : shown.join(", ");
}

export function toSynthesisModel(model: ModelLike): SynthesisModel {
  return { provider: model.provider, id: model.id, supportsImage: (model.input ?? []).includes("image"), contextWindow: model.contextWindow, maxTokens: model.maxTokens, inputLimits: model.inputLimits };
}

/** Concatenate the text blocks of an assistant message. */
export function assistantText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

export interface TwitterApiSynthesisOptions extends BackendOptions {
  config: TwitterConfig;
  /**
   * Fixed local UTC offset in minutes. Omit to use the host timezone. Exposed so
   * the trim-band behaviour can be tested deterministically.
   */
  localUtcOffsetMinutes?: number;
}

