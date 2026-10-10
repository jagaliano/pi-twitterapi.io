import assert from "node:assert/strict";
import test from "node:test";
import { loadTwitterConfig } from "./config.js";
import { buildCandidatePrompt, synthesizeAnswer } from "./synthesize.js";
import type { Tweet } from "./twitterapi.js";

const roots = (): Tweet[] => Array.from({ length: 1_000 }, (_, i) => ({
  id: String(i + 1), url: `https://x.com/a/status/${i + 1}`, author: { userName: "a" }, text: "x",
  media: Array.from({ length: 4 }, (_, j) => ({ type: "photo", url: `https://pbs.twimg.com/${i}-${j}.jpg` })),
}));
const model = { provider: "test", id: "large", supportsImage: false, contextWindow: 1_000_000, maxTokens: 8_192 };
const config = loadTwitterConfig({ twitter: { maxSynthesisChars: 120_000, enableImageUnderstanding: false, enableVideoUnderstanding: false, enableVideoProcessing: false } });
const now = () => Date.UTC(2026, 9, 9, 12);

test("unique assets never search the full candidate list with an empty mapped set", () => {
  const original = Set.prototype.has;
  let emptyProbes = 0;
  try {
    // Bound algorithmic work, not host-specific milliseconds. Only collector
    // candidates have both media and bindings; other sets are unaffected.
    Set.prototype.has = function(value: unknown) {
      if (this.size === 0 && value && typeof value === "object" && "media" in value && "bindings" in value) {
        emptyProbes++; throw new Error("unmapped asset scanned prior candidates");
      }
      return original.call(this, value);
    };
    assert.ok(buildCandidatePrompt("q", roots(), [], { now }).includes("Posts (1000)"));
    assert.equal(emptyProbes, 0);
  } finally { Set.prototype.has = original; }
});

test("ownership lookup is indexed for one thousand distinct four-photo roots", () => {
  let reads = 0;
  const posts = roots();
  for (const post of posts) {
    const url = post.url;
    Object.defineProperty(post, "url", { get() {
      assert.ok(++reads < 100_000, "ownership rescanned unrelated roots instead of using identity indexes");
      return url;
    } });
  }
  assert.ok(buildCandidatePrompt("q", posts, [], { now }).includes("Posts (1000)"));
  assert.ok(reads < 100_000);
});

test("shared asset bindings do not rescan every unrelated enclosing post", () => {
  const posts = roots();
  let reads = 0;
  for (const post of posts) {
    post.media = [{ type: "photo", url: "https://pbs.twimg.com/shared.jpg" }];
    const url = post.url;
    Object.defineProperty(post, "url", { get() {
      assert.ok(++reads < 100_000, "shared asset binding lookup rescanned unrelated owners");
      return url;
    } });
  }
  const BaseURL = globalThis.URL;
  let parses = 0;
  try {
    globalThis.URL = class extends BaseURL {
      constructor(input: string | URL, base?: string | URL) { parses++; super(input, base); }
    };
    assert.ok(buildCandidatePrompt("q", posts, [], { now }).includes("Posts (1000)"));
    assert.ok(parses < 100_000, `shared bindings parsed unrelated identities ${parses} times`);
  } finally { globalThis.URL = BaseURL; }
});

test("bound images and video evidence use only mapped enclosing references", () => {
  const posts = roots();
  let reads = 0;
  for (const post of posts) {
    post.media = [{ type: "video", url: "https://pbs.twimg.com/shared.jpg", videoVariants: ["https://video.twimg.com/shared.mp4"] }];
    const url = post.url;
    Object.defineProperty(post, "url", { get() {
      assert.ok(++reads < 100_000, "renderer rescanned unrelated bound references");
      return url;
    } });
  }
  const bindings = posts.map(post => ({ enclosingPostId: post.id, enclosingPostUrl: post.url, sourcePostId: post.id, sourcePostUrl: post.url }));
  const prompt = buildCandidatePrompt("q", posts,
    bindings.map(binding => ({ binding, postUrl: binding.sourcePostUrl!, method: "transcript-only", transcript: "shared speech" })),
    { now, mediaReferences: bindings.map(binding => ({ binding, imageIndex: 0 })) });
  assert.equal(prompt.match(/^image references: 1 /gm)?.length, 1_000);
  assert.equal(prompt.match(/^transcript: shared speech$/gm)?.length, 1_000);
});

test("disabled root-only selection does not rebuild unused inventories for every prefix", async () => {
  const posts = roots().slice(0, 64);
  let locatorReads = 0;
  for (const post of posts) for (const media of post.media!) {
    const url = media.url;
    Object.defineProperty(media, "url", { get() { locatorReads++; return url; } });
  }
  await synthesizeAnswer({ query: "q", tweets: posts, config, model, deps: { now, complete: async () => "No links" } });
  assert.ok(locatorReads < 10_000, `unused inventory was rebuilt: ${locatorReads} asset locator reads`);
});

test("supported-size media-disabled selection fits without media billing", { timeout: 30_000 }, async (t) => {
  let media = 0, completions = 0;
  const details = await synthesizeAnswer({ query: "q", tweets: roots(), config, model, deps: {
    now, signal: t.signal, fetchMedia: async () => { media++; return undefined; }, complete: async request => {
      completions++;
      assert.ok(request.prompt.includes("Posts (1000)"));
      assert.ok(request.system.length + request.prompt.length < 120_000);
      return "No links";
    },
  } });
  assert.equal(media, 0); assert.equal(completions, 1);
  assert.ok(!details.notes?.some(note => /omitted .*post bundle/.test(note)));
});

test("large input selection yields to cancellation before media or completion work", async () => {
  const controller = new AbortController();
  const abort = setImmediate(() => controller.abort());
  let work = 0;
  try {
    await assert.rejects(synthesizeAnswer({ query: "q", tweets: roots(), config, model, deps: {
      now, signal: controller.signal, fetchMedia: async () => { work++; return undefined; },
      complete: async () => { work++; return "unexpected"; },
    } }), { name: "AbortError" });
    assert.equal(work, 0);
  } finally { clearImmediate(abort); }
});

test("indexed ownership preserves anonymous ID-only URL-only and complete identities", () => {
  for (const identity of [{}, { id: "1" }, { url: "https://x.com/a/status/1" }, { id: "1", url: "https://x.com/a/status/1" }]) {
    const media = { type: "photo", url: "https://pbs.twimg.com/shared.jpg", altText: "source caption" };
    const prompt = buildCandidatePrompt("q", [{ ...identity, text: "root", media: [media],
      retweetOf: { id: "2", url: "https://x.com/b/status/2", text: "original", media: [{ ...media }] },
    }], [], { now });
    assert.ok(!prompt.slice(0, prompt.indexOf("reposted source:")).includes("source caption"));
    assert.match(prompt, /reposted media 1 alt text.*source caption/);
  }
});

test("root quoted and reposted headings render reply counts including zero", () => {
  const prompt = buildCandidatePrompt("q", [{ id: "1", text: "root", replyCount: 0,
    quoted: { id: "2", text: "quote", replyCount: 123 }, retweetOf: { id: "3", text: "repost", replyCount: 7 },
  }], [], { now });
  assert.match(prompt, /^\[1\].*0 replies$/m);
  assert.match(prompt, /^quoted source:.*123 replies/m);
  assert.match(prompt, /^reposted source:.*7 replies/m);
  assert.ok(!buildCandidatePrompt("q", [{ text: "missing" }], [], { now }).includes("replies"));
});
