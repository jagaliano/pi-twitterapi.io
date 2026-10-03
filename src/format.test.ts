import assert from "node:assert/strict";
import test from "node:test";

import { formatTwitterResults } from "./format.js";

test("formats the tool contract", () => {
  const markdown = formatTwitterResults({
    query: "what is new",
    model: "anthropic/claude-haiku",
    text: "A model shipped.",
    citations: ["https://x.com/a/status/1", "https://x.com/b/status/2"],
    synthesisCalls: 2,
  });

  assert.equal(
    markdown,
    [
      "Query: what is new",
      "Model: anthropic/claude-haiku",
      "Synthesis Calls: 2",
      "Citations: 2",
      "",
      "## Answer",
      "",
      "A model shipped.",
      "",
      "## Sources",
      "",
      "1. https://x.com/a/status/1",
      "2. https://x.com/b/status/2",
    ].join("\n"),
  );
});

test("omits Sources when there are no citations and falls back for empty text", () => {
  const markdown = formatTwitterResults({
    query: "q",
    model: "m",
    text: "",
    citations: [],
  });
  assert.match(markdown, /No answer text returned\./);
  assert.doesNotMatch(markdown, /## Sources/);
});

test("appends a Notes section only when notes are present", () => {
  const withoutNotes = formatTwitterResults({ query: "q", model: "m", text: "t", citations: [] });
  assert.doesNotMatch(withoutNotes, /## Notes/);

  const withNotes = formatTwitterResults({
    query: "q",
    model: "m",
    text: "t",
    citations: ["https://x.com/a/status/1"],
    notes: ["first note", "second note"],
  });
  assert.ok(withNotes.endsWith("## Notes\n\n- first note\n- second note"));
});
