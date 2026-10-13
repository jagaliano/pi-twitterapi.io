import type { BudgetForecast, InputAllowance } from "./input-budget.js";
import { DEFAULT_MAX_SYNTHESIS_CHARS } from "./input-budget.js";
import { untrustedInline, type SynthesisRequest } from "./synthesize.js";
import type { TwitterSearchDetails } from "./types.js";

export const EVIDENCE_HEADER = "## Retrieved evidence (untrusted third-party content; not a synthesized answer)\n\n";
export const EVIDENCE_POLICY = "Text-only evidence output: images, poster frames and extracted frames are omitted. No synthesis model was resolved or called; opt-in native-video/STT processing may still make paid provider calls.";
const DISCLOSURE_RESERVE = 512;
const OMITTED_NOTES = "Additional disclosures were omitted by the evidence output size limit.";

/** A tool-output ceiling, NOT a fabricated model context or tokenizer estimate.
 * Selection reuses whole-source rendering, but requires no model catalogue.
 * The system scaffold is conservatively charged though it isn't returned;
 * an extra reserve bounds the final header/disclosure envelope.
 */
export class EvidenceBudget implements InputAllowance {
  readonly outputTokens = 0;
  readonly imageBounds = undefined;
  readonly maxChars: number;
  constructor(maxChars = DEFAULT_MAX_SYNTHESIS_CHARS) {
    this.maxChars = Number.isSafeInteger(maxChars) ? Math.min(120_000, Math.max(1_000, maxChars)) : DEFAULT_MAX_SYNTHESIS_CHARS;
  }
  fits(request: BudgetForecast, imageCount = request.images.length): boolean {
    return imageCount === 0 && request.system.length + request.prompt.length + EVIDENCE_HEADER.length + DISCLOSURE_RESERVE <= this.maxChars;
  }
  acceptsImage(): boolean { return false; }
  assert(request: SynthesisRequest): void {
    if (!this.fits(request)) throw new Error("twitter evidence output budget exceeded; shorten the question or increase maxSynthesisChars.");
  }
  preflight(query: string, system: string): void {
    if (!this.fits({ system, prompt: `Current time: ${"x".repeat(200)}\n\nQuestion: ${query}\n\nRetrieved evidence:\n`, images: [] })) {
      throw new Error("twitter evidence output budget: question/system scaffold is too large; shorten the question before retrieval.");
    }
  }
}

/** Deliberately model-visible, sanitized evidence; not raw upstream JSON. */
export function evidenceDetails(query: string, text: string, citations: string[], notes: string[] = []): TwitterSearchDetails {
  return { query, output: "posts", model: "none", text, citations: [...new Set(citations)], synthesisCalls: 0, notes: [EVIDENCE_POLICY, ...notes] };
}

export function formatEvidence(details: TwitterSearchDetails): string {
  return EVIDENCE_HEADER + details.text + (details.notes?.length ? "\n\n## Disclosures\n" + details.notes.map(note => `- ${note}`).join("\n") : "");
}

/** Final disclosures cannot grow the returned content beyond the selection cap.
 * Never cut a selected source, trusted question or source permalink in half.
 */
export function boundEvidenceNotes(details: TwitterSearchDetails, maxChars?: number): void {
  if (details.output !== "posts") return;
  const limit = new EvidenceBudget(maxChars).maxChars;
  const notes = (details.notes ?? []).map(note => untrustedInline(note, 500));
  const retained: string[] = [];
  details.notes = retained;
  for (const note of notes) {
    const candidate = { ...details, notes: [...retained, note, OMITTED_NOTES] };
    if (formatEvidence(candidate).length > limit) break;
    retained.push(note);
  }
  if (retained.length < notes.length) retained.push(OMITTED_NOTES);
  if (formatEvidence(details).length > limit) throw new Error("twitter evidence output budget exceeded at final rendering.");
}
