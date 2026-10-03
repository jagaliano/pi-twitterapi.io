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
  /** Synthesis completions run while answering (0 when nothing was synthesized). */
  synthesisCalls?: number;
  /** Disclosures worth surfacing to the user; rendered as a trailing `## Notes` section. */
  notes?: string[];
}
