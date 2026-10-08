import type { ImageAttachment, SynthesisRequest } from "./synthesize.js";

export const DEFAULT_MAX_SYNTHESIS_CHARS = 60_000;
export const MESSAGE_TOKEN_RESERVE = 1_024;
export interface ImageInputBounds {
  tokensPerImage: number;
  maxWidth: number;
  maxHeight: number;
  maxImages: number;
  /** Raw decoded bytes, not base64 bytes. */
  maxBytes: number;
}
export interface BudgetModel {
  provider: string;
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsImage?: boolean;
  input?: readonly string[];
  inputLimits?: {
    maxRequestBytes?: number;
    images?: { maxPerMessage?: number; maxPerRequest?: number; resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number } };
  };
}
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const spec = (model: BudgetModel): string => `${model.provider}/${model.id}`;
export const renderedPrompt = (request: Pick<SynthesisRequest, "prompt" | "images" | "mediaManifest">): string =>
  request.images.length && request.mediaManifest ? `${request.prompt}\n\nAttached images, in order:\n${request.mediaManifest}` : request.prompt;

/** Remove only renderer-owned attachment reference lines, not retrieved text. */
export function withoutImages(request: SynthesisRequest): SynthesisRequest {
  if (!request.images.length) return { ...request, mediaManifest: undefined };
  return { ...request, images: [], mediaManifest: undefined, prompt: request.textOnlyPrompt ?? request.prompt.replace(/^(?:(?:quoted|reposted) )?image references: \d+(?:, \d+)* \(only if images delivered\)\n?/gm, "") };
}

/** Inspect actual bytes; caller-supplied dimensions and MIME labels aren't evidence. */
export function imageDimensions(image: ImageAttachment, maxBytes: number): { width: number; height: number } | undefined {
  if (image.data.length > Math.ceil(maxBytes / 3) * 4 || image.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return undefined;
  const data = Buffer.from(image.data, "base64");
  if (data.length > maxBytes) return undefined;
  if (image.mimeType === "image/png") {
    if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.toString("ascii", 12, 16) !== "IHDR" || data.readUInt32BE(8) !== 13) return undefined;
    let end = false;
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = data.readUInt32BE(offset), next = offset + length + 12;
      if (next > data.length) return undefined;
      const type = data.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") return undefined; // Animated PNG is not one bounded image.
      if (type === "IEND") { end = true; break; }
      offset = next;
    }
    if (!end) return undefined;
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (image.mimeType === "image/jpeg") {
    if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) return undefined;
    let dimensions: { width: number; height: number } | undefined;
    for (let offset = 2; offset < data.length;) {
      if (data[offset++] !== 0xff) return undefined;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda) return dimensions;
      if (marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) return undefined;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return undefined;
      if ([0xc0,0xc1,0xc2].includes(marker)) {
        if (dimensions || length < 8) return undefined;
        dimensions = { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
  }
  return undefined; // Unknown raster/animation encodings aren't guessed.
}

type BudgetForecast = Pick<SynthesisRequest, "system" | "prompt" | "images" | "mediaManifest" | "textOnlyPrompt"> & {
  /** Separate rendered JSON worst case; UTF-8/token accounting uses the main prompt. */
  jsonForecast?: { prompt: string; textOnlyPrompt: string; mediaManifest?: string };
};

/** Conservative byte-token accounting, not an exact provider tokenizer. */
export class InputBudget {
  readonly outputTokens: number;
  readonly maxChars: number;
  readonly models: readonly BudgetModel[];
  readonly imageBounds?: ImageInputBounds;
  private readonly bounds = new Map<string, ImageInputBounds>();
  constructor(models: readonly BudgetModel[], maxChars = DEFAULT_MAX_SYNTHESIS_CHARS, profiles: Record<string, ImageInputBounds> = {}) {
    if (!models.length) throw new Error("twitter input budget needs a resolved synthesis model");
    this.models = models.map(model => ({ ...model, inputLimits: model.inputLimits ? { ...model.inputLimits, images: model.inputLimits.images ? { ...model.inputLimits.images, resize: model.inputLimits.images.resize ? { ...model.inputLimits.images.resize } : undefined } : undefined } : undefined }));
    this.maxChars = positive(maxChars) ? Math.min(120_000, Math.max(1_000, maxChars)) : DEFAULT_MAX_SYNTHESIS_CHARS;
    for (const model of models) {
      if (!positive(model.contextWindow) || !positive(model.maxTokens)) throw new Error(`twitter input budget: ${spec(model)} has unknown or invalid contextWindow/maxTokens; configure valid catalogue limits before retrieval.`);
      if (model.inputLimits?.maxRequestBytes !== undefined && !positive(model.inputLimits.maxRequestBytes)) throw new Error(`twitter input budget: ${spec(model)} has invalid maxRequestBytes`);
      const declared = profiles[spec(model)];
      if (!(model.supportsImage ?? model.input?.includes("image")) || !declared) continue;
      if (!Object.values(declared).every(positive) || !["tokensPerImage","maxWidth","maxHeight","maxImages","maxBytes"].every(key => positive(declared[key as keyof ImageInputBounds]))) throw new Error(`twitter input budget: invalid image bounds for ${spec(model)}`);
      const bound = { ...declared }, limits = model.inputLimits?.images;
      if (positive(limits?.resize?.maxWidth)) bound.maxWidth = Math.min(bound.maxWidth, limits.resize.maxWidth);
      if (positive(limits?.resize?.maxHeight)) bound.maxHeight = Math.min(bound.maxHeight, limits.resize.maxHeight);
      // Catalogue resize.maxBytes is BASE64 bytes; our setting is RAW bytes.
      if (positive(limits?.resize?.maxBytes)) bound.maxBytes = Math.min(bound.maxBytes, Math.floor(limits.resize.maxBytes / 4) * 3);
      for (const limit of [limits?.maxPerMessage, limits?.maxPerRequest]) if (typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0) bound.maxImages = Math.min(bound.maxImages, limit);
      this.bounds.set(spec(model), bound);
    }
    this.outputTokens = Math.min(4_096, ...models.map(model => Math.min(model.maxTokens!, Math.max(1, Math.floor(model.contextWindow! / 4)))));
    const primary = this.bounds.get(spec(models[0]));
    if (primary) {
      this.imageBounds = { ...primary };
      for (const bound of this.bounds.values()) for (const key of ["maxWidth","maxHeight","maxImages","maxBytes"] as const) this.imageBounds[key] = Math.min(this.imageBounds[key], bound[key]);
    }
  }
  acceptsImages(model: BudgetModel): boolean { return this.bounds.has(spec(model)); }
  acceptsImage(image: ImageAttachment): boolean {
    const bound = this.imageBounds;
    if (!bound) return false;
    const d = imageDimensions(image, bound.maxBytes);
    return Boolean(d && d.width > 0 && d.height > 0 && d.width <= bound.maxWidth && d.height <= bound.maxHeight);
  }
  /** Forecast uses a count only; physical calls additionally validate every raster. */
  fits(request: BudgetForecast, imageCount = request.images.length, target?: BudgetModel): boolean {
    for (const model of target ? [target] : this.models) {
      const bound = this.bounds.get(spec(model));
      const count = bound ? imageCount : 0;
      if (count && (!positive(bound!.maxBytes) || !positive(bound!.maxWidth) || !positive(bound!.maxHeight) || count > bound!.maxImages)) return false;
      const prompt = count ? renderedPrompt({ ...request, images: [{} as ImageAttachment] }) : withoutImages(request as SynthesisRequest).prompt;
      const text = request.system + "\n" + prompt;
      if (text.length > this.maxChars || Buffer.byteLength(text, "utf8") + MESSAGE_TOKEN_RESERVE + count * (bound?.tokensPerImage ?? 0) + this.outputTokens > model.contextWindow!) return false;
      if (positive(model.inputLimits?.maxRequestBytes)) {
        // Forecast reserves declared encoded bytes for every planned slot. Physical
        // validation below uses real payloads; envelope reserve covers routing fields.
        const encoded = count ? (imageCount === request.images.length && request.images.every(image => typeof image.data === "string") ? request.images.reduce((sum, image) => sum + image.data.length, 0) : count * Math.ceil(bound!.maxBytes / 3) * 4) : 0;
        const serializedPrompt = request.jsonForecast
          ? count ? renderedPrompt({ ...request.jsonForecast, images: [{} as ImageAttachment] }) : request.images.length ? request.jsonForecast.textOnlyPrompt : request.jsonForecast.prompt
          : prompt;
        if (Buffer.byteLength(JSON.stringify({ system: request.system, prompt: serializedPrompt }), "utf8") + encoded + MESSAGE_TOKEN_RESERVE + count * 256 > model.inputLimits.maxRequestBytes) return false;
      }
    }
    return true;
  }
  assert(request: SynthesisRequest, target?: BudgetModel): void {
    if (request.maxTokens !== this.outputTokens || !this.fits(request, request.images.length, target)) throw new Error("twitter input budget exceeded: complete rendered input plus reserved output does not fit the configured limits.");
    if (request.images.length && (!this.imageBounds || request.images.some(image => !this.acceptsImage(image)))) throw new Error("twitter input budget: attachment exceeds declared raster/dimension/byte bounds.");
  }
  preflight(query: string, system: string): void {
    const request = { system, prompt: `Current time: ${"x".repeat(200)}\n\nQuestion: ${query}\n\nRetrieved evidence:\n`, images: [], maxTokens: this.outputTokens } as unknown as SynthesisRequest;
    if (!this.fits(request)) throw new Error("twitter input budget: question/system scaffold is too large; shorten the question or configure a model with a larger valid context before retrieval.");
  }
}
