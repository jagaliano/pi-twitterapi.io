import type { TwitterConfig } from "../config.js";
import type { RunTelemetry } from "../telemetry.js";
import { assistantText, resolveModel, type RegistryLike } from "./model.js";

/** OpenAI-compatible direct endpoints already use slash-containing upstream ids. */
export function usesPiVideoModel(config: TwitterConfig): boolean {
  return config.videoEndpointType === "gemini-files" && Boolean(config.videoModel?.includes("/"));
}

class ProviderVideoError extends Error {}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Attach only to the user turn of our isolated, text-only analysis request. */
function withGoogleVideo(payload: Record<string, unknown>, data: string): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.contents)) return undefined;
  const contents = [...payload.contents];
  const index = contents.map(turn => object(turn) && turn.role === "user" && Array.isArray(turn.parts)).lastIndexOf(true);
  if (index < 0) return undefined;
  const turn = contents[index] as Record<string, unknown> & { parts: unknown[] };
  const attached = turn.parts.some(part => object(part) && object(part.inlineData) &&
    part.inlineData.mimeType === "video/mp4" && part.inlineData.data === data);
  contents[index] = { ...turn, parts: attached ? turn.parts : [...turn.parts, { inlineData: { mimeType: "video/mp4", data } }] };
  return { ...payload, contents };
}

/** A provider ignoring cancellation cannot hold this caller open indefinitely. */
async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Native video was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) abort(); else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

export interface ProviderVideoResult { text?: string; error?: string; }

/**
 * Pi owns authentication, endpoint selection and transport. Never resolve/copy its
 * keys. Pi's message API has no video part, so its documented onPayload hook is
 * required. A hook-less provider's text-only reply is NOT usable video evidence.
 * Hook forwarding and downstream video support remain the provider's contract.
 */
export async function providerVideo(options: {
  registry?: RegistryLike;
  model: string;
  bytes: Uint8Array;
  prompt: string;
  signal: AbortSignal;
  /** Absolute phase expiry is checked independently of timer delivery. */
  deadline?: number;
  now?: () => number;
  telemetry?: RunTelemetry;
}): Promise<ProviderVideoResult> {
  const { registry, signal, telemetry } = options;
  signal.throwIfAborted();
  if (!registry || typeof registry.complete !== "function") {
    return { error: "Pi's model registry/completion API is unavailable for the configured native-video model." };
  }
  let model;
  try { model = resolveModel(registry, options.model); }
  catch { return { error: "The native-video model reference is ambiguous; use its exact provider/model id from Pi's catalogue." }; }
  if (!model) return { error: "The configured native-video provider/model was not found in Pi's model catalogue." };
  const maxTokens = model.maxTokens;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) return { error: "The native-video model has no usable output limit." };

  const data = Buffer.from(options.bytes).toString("base64");
  let attached = false;
  let closed = false;
  let payloadError: string | undefined;
  const assertActive = () => {
    signal.throwIfAborted();
    if (closed) throw new ProviderVideoError("The Pi native-video operation has already finished.");
    if (options.deadline !== undefined && (options.now ?? Date.now)() >= options.deadline) {
      throw new ProviderVideoError("The Pi native-video request exceeded its deadline.");
    }
  };
  const onPayload = (payload: unknown) => {
    assertActive();
    let next: Record<string, unknown> | undefined;
    if (object(payload)) {
      next = withGoogleVideo(payload, data);
      if (!next && object(payload.request)) {
        const request = withGoogleVideo(payload.request, data);
        if (request) next = { ...payload, request };
      }
      // Gemini hosted behind a Pi-managed OpenAI-compatible provider (e.g.
      // OpenRouter) needs video_url, not an image or the unsupported input_video.
      if (!next && model.api === "openai-completions" && Array.isArray(payload.messages)) {
        const messages = [...payload.messages];
        const index = messages.map(turn => object(turn) && turn.role === "user" &&
          (typeof turn.content === "string" || Array.isArray(turn.content))).lastIndexOf(true);
        if (index >= 0) {
          const turn = messages[index] as Record<string, unknown> & { content: string | unknown[] };
          const content = typeof turn.content === "string" ? [{ type: "text", text: turn.content }] : turn.content;
          const url = `data:video/mp4;base64,${data}`;
          const attached = content.some(part => object(part) && part.type === "video_url" &&
            object(part.video_url) && part.video_url.url === url);
          messages[index] = { ...turn, content: attached ? content : [...content, { type: "video_url", video_url: { url } }] };
          next = { ...payload, messages };
        }
      }
    }
    if (!next) {
      payloadError = "The Pi provider does not expose a supported native-video payload through onPayload; check the provider extension's video support.";
      throw new ProviderVideoError(payloadError);
    }
    attached = true;
    return next;
  };
  let invoked = false;
  try {
    const message = await abortable(signal, () => {
      assertActive();
      invoked = true;
      if (telemetry) telemetry.usage.nativeVideoSdkAttempts = (telemetry.usage.nativeVideoSdkAttempts ?? 0) + 1;
      return registry.complete!.call(registry, model as never, {
        messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
      } as never, { signal, maxTokens: Math.min(4_000, maxTokens), onPayload } as never);
    });
    assertActive();
    const reason = object(message) ? message.stopReason : undefined;
    if (payloadError) throw new ProviderVideoError(payloadError);
    if (reason !== "stop") throw new ProviderVideoError(
      reason === "length" ? "The Pi native-video provider truncated its answer at the token limit." :
        "The Pi native-video provider did not complete successfully; check its authentication, configuration and native-video support.",
    );
    if (!attached) throw new ProviderVideoError("The Pi provider did not forward native video through onPayload; its text-only reply was discarded. Native-video support depends on the provider extension.");
    const text = assistantText(message);
    if (!text) throw new ProviderVideoError("The Pi native-video provider returned no text content.");
    return { text };
  } catch (error) {
    if (invoked && telemetry) telemetry.usage.nativeVideoSdkFailures = (telemetry.usage.nativeVideoSdkFailures ?? 0) + 1;
    // Provider exceptions can contain credentials or whole payloads. Only our
    // own diagnostics above are safe to disclose; never echo arbitrary errors.
    const own = error instanceof ProviderVideoError;
    return { error: signal.aborted ? "The Pi native-video request was cancelled or exceeded its deadline." :
      own ? error.message : "The Pi native-video call failed; check the provider's authentication, configuration and native-video support." };
  } finally {
    closed = true;
  }
}
