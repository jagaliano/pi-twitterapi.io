import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_MEDIA_PER_SEARCH, loadTwitterConfig } from "./config.js";

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
      maxMediaPerSearch: -3,
      enableImageUnderstanding: "yes",
      enableVideoUnderstanding: 1,
    },
  });
  assert.equal(config.synthesisModel, undefined);
  assert.equal(config.maxMediaPerSearch, DEFAULT_MAX_MEDIA_PER_SEARCH);
  assert.equal(config.enableImageUnderstanding, false);
  assert.equal(config.enableVideoUnderstanding, false);
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

test("an xsearch settings block cannot configure this extension", () => {
  const config = loadTwitterConfig({ xsearch: { synthesisModel: "anthropic/haiku", maxPages: 9 } });
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
