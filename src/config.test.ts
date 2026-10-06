import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_MEDIA_PER_SEARCH, VIDEO_ENDPOINT_TYPES, loadTwitterConfig } from "./config.js";

test("loadTwitterConfig defaults the media settings and leaves synthesisModel unset", () => {
  const config = loadTwitterConfig({});
  assert.equal(config.synthesisModel, undefined);
  assert.equal(config.enableImageUnderstanding, false);
  assert.equal(config.enableVideoUnderstanding, false);
  assert.equal(config.maxMediaPerSearch, DEFAULT_MAX_MEDIA_PER_SEARCH);
});

test("loadTwitterConfig reads the twitter block", () => {
  const config = loadTwitterConfig({
    twitter: {
      synthesisModel: "anthropic/claude-haiku-4-5-20251001",
      enableImageUnderstanding: true,
      enableVideoUnderstanding: true,
      maxMediaPerSearch: 2,
    },
  });
  assert.equal(config.synthesisModel, "anthropic/claude-haiku-4-5-20251001");
  assert.equal(config.enableImageUnderstanding, true);
  assert.equal(config.enableVideoUnderstanding, true);
  assert.equal(config.maxMediaPerSearch, 2);
});

test("loadTwitterConfig ignores malformed values instead of throwing", () => {
  const config = loadTwitterConfig({
    twitter: {
      synthesisModel: "   ",
      maxMediaPerSearch: "many",
      enableImageUnderstanding: "yes",
      enableVideoUnderstanding: 1,
    },
  });
  assert.equal(config.synthesisModel, undefined);
  assert.equal(config.maxMediaPerSearch, DEFAULT_MAX_MEDIA_PER_SEARCH);
  assert.equal(config.enableImageUnderstanding, false);
  assert.equal(config.enableVideoUnderstanding, false);
  assert.ok(
    config.configNotes.some((note) => /twitter\.maxMediaPerSearch .* is not an integer/.test(note)),
    "a non-integer falls back to the default and says so",
  );
});

test("an out-of-range numeric setting is clamped and disclosed (G8)", () => {
  const config = loadTwitterConfig({ twitter: { maxMediaPerSearch: -3, maxFrames: 99 } });
  assert.equal(config.maxMediaPerSearch, 0, "-3 clamps to the supported minimum");
  assert.equal(config.maxFrames, 16, "99 clamps to the supported maximum");
  assert.ok(
    config.configNotes.some((note) =>
      /twitter\.maxMediaPerSearch -3 is outside the supported range 0\.\.20; using 0\./.test(note),
    ),
  );
  assert.ok(
    config.configNotes.some((note) =>
      /twitter\.maxFrames 99 is outside the supported range 1\.\.16; using 16\./.test(note),
    ),
  );
});

test("a numeric setting inside its range is used as-is, without a note (G8)", () => {
  const config = loadTwitterConfig({
    twitter: { maxMediaPerSearch: 3, maxFrames: 8, maxVideoSeconds: 600, videoBudgetMs: 300_000 },
  });
  assert.equal(config.maxMediaPerSearch, 3);
  assert.equal(config.maxFrames, 8);
  assert.equal(config.maxVideoSeconds, 600);
  assert.equal(config.videoBudgetMs, 300_000);
  assert.deepEqual(config.configNotes, []);
});

test("loadTwitterConfig caps maxMediaPerSearch", () => {
  assert.equal(loadTwitterConfig({ twitter: { maxMediaPerSearch: 500 } }).maxMediaPerSearch, 20);
  assert.equal(loadTwitterConfig({ twitter: { maxMediaPerSearch: 0 } }).maxMediaPerSearch, 0);
  assert.equal(loadTwitterConfig({ twitter: { maxMediaPerSearch: 1.5 } }).maxMediaPerSearch, DEFAULT_MAX_MEDIA_PER_SEARCH);
});

test("loadTwitterConfig tolerates a non-object twitter block", () => {
  assert.equal(loadTwitterConfig({ twitter: "nope" }).synthesisModel, undefined);
  assert.equal(loadTwitterConfig({ twitter: [] }).synthesisModel, undefined);
});

test("an unrecognised videoEndpointType falls back to the default and discloses it", () => {
  const config = loadTwitterConfig({ twitter: { videoEndpointType: "openai-compat" } });
  assert.equal(config.videoEndpointType, "gemini-files");
  // Assert the whole note: a loose pattern would still pass if the message dropped
  // the accepted values, which is the part that makes the typo fixable.
  assert.deepEqual(config.configNotes, [
    `twitter.videoEndpointType "openai-compat" is not one of ${VIDEO_ENDPOINT_TYPES.join(", ")}; ` +
      "native video is disabled for this value, and no provider will be guessed for it.",
  ]);
});

test("a recognised videoEndpointType is accepted without a note", () => {
  const config = loadTwitterConfig({ twitter: { videoEndpointType: "openai-compatible" } });
  assert.equal(config.videoEndpointType, "openai-compatible");
  assert.deepEqual(config.configNotes, []);
});

test("only a non-empty unrecognised videoEndpointType is disclosed", () => {
  for (const value of [undefined, "", "   "]) {
    const config = loadTwitterConfig({ twitter: { videoEndpointType: value } });
    assert.equal(config.videoEndpointType, "gemini-files");
    assert.deepEqual(config.configNotes, [], `${JSON.stringify(value)} must stay silent`);
  }
});

test("every accepted videoEndpointType is taken as-is, padding included", () => {
  for (const value of VIDEO_ENDPOINT_TYPES) {
    assert.equal(loadTwitterConfig({ twitter: { videoEndpointType: value } }).videoEndpointType, value);
    const padded = loadTwitterConfig({ twitter: { videoEndpointType: `  ${value}  ` } });
    assert.equal(padded.videoEndpointType, value);
    assert.equal(padded.videoEndpointTypeInvalid, false);
    assert.deepEqual(padded.configNotes, []);
  }
  // Padding does not rescue an unrecognised value.
  assert.equal(loadTwitterConfig({ twitter: { videoEndpointType: " openrouter " } }).configNotes.length, 1);
});

test("a project-level videoEndpointType cannot select the adapter", () => {
  const config = loadTwitterConfig(
    {},
    { projectSettings: { twitter: { videoEndpointType: "openai-compatible" } } },
  );
  assert.equal(config.videoEndpointType, "gemini-files");
  assert.equal(config.videoEndpointTypeInvalid, false, "an ignored project value is not an invalid user value");
  assert.ok(
    config.configNotes.some((note) => /twitter\.videoEndpointType from project settings was ignored/.test(note)),
  );
});

test("an unrecognised videoEndpointType is flagged so native video is skipped", () => {
  assert.equal(
    loadTwitterConfig({ twitter: { videoEndpointType: "openai-compat" } }).videoEndpointTypeInvalid,
    true,
  );
  assert.equal(
    loadTwitterConfig({ twitter: { videoEndpointType: "openai-compatible" } }).videoEndpointTypeInvalid,
    false,
  );
  assert.equal(loadTwitterConfig({}).videoEndpointTypeInvalid, false);
  assert.equal(loadTwitterConfig({ twitter: { videoEndpointType: "   " } }).videoEndpointTypeInvalid, false);
});

test("only the twitter settings block is read", () => {
  const config = loadTwitterConfig({ someOtherExtension: { synthesisModel: "anthropic/haiku", maxPages: 9 } });
  assert.equal(config.synthesisModel, undefined);
  assert.equal(config.maxPages, 5, "only the twitter block is read");
});

test("a ceiling caps maxPages rather than being raised to it", () => {
  const capped = loadTwitterConfig({ twitter: { maxPages: 5, maxPagesCeiling: 2 } });
  assert.equal(capped.maxPagesCeiling, 2);
  assert.equal(capped.maxPages, 2, "the base budget is clamped down to the ceiling");

  const normal = loadTwitterConfig({ twitter: { maxPages: 3, maxPagesCeiling: 10 } });
  assert.equal(normal.maxPages, 3);
  assert.equal(normal.maxPagesCeiling, 10);

  const defaults = loadTwitterConfig({});
  assert.equal(defaults.maxPages, 5);
  assert.equal(defaults.maxPagesCeiling, 20);
});
