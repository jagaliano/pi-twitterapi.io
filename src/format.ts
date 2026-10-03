import type { TwitterSearchDetails } from "./types.js";

export function formatTwitterResults(details: TwitterSearchDetails): string {
  const lines = [
    `Query: ${details.query}`,
    `Model: ${details.model}`,
    `Synthesis Calls: ${details.synthesisCalls ?? 0}`,
    `Citations: ${details.citations.length}`,
    "",
    "## Answer",
    "",
    details.text || "No answer text returned.",
  ];

  if (details.citations.length > 0) {
    lines.push("", "## Sources", "");
    details.citations.forEach((citation, index) => {
      lines.push(`${index + 1}. ${citation}`);
    });
  }

  if (details.notes?.length) {
    lines.push("", "## Notes", "");
    details.notes.forEach((note) => lines.push(`- ${note}`));
  }

  return lines.join("\n");
}
