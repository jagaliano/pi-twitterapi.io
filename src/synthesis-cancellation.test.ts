import assert from "node:assert/strict";
import test from "node:test";
import { loadTwitterConfig } from "./config.js";
import { synthesizeAnswer } from "./synthesize.js";
import { TEST_LIMITS, TEST_IMAGE_BOUNDS, TEST_IMAGE } from "./fixtures/budget.js";
import type { Tweet } from "./twitterapi.js";

const model = { ...TEST_LIMITS, provider: "test", id: "large", supportsImage: true };
const config = loadTwitterConfig({ twitter: { enableImageUnderstanding: true, imageInputBounds: { "test/large": TEST_IMAGE_BOUNDS } } });
const post: Tweet = { id: "1", url: "https://x.com/a/status/1", text: "source", media: [
  { type: "photo", url: "https://pbs.twimg.com/one.jpg" }, { type: "photo", url: "https://pbs.twimg.com/two.jpg" },
] };

for (const source of ["top", "deps", "both"] as const) {
  test(`queued cancellation at selection await prevents paid work (${source} signal)`, async () => {
    const controller = new AbortController();
    let media = 0, completions = 0;
    queueMicrotask(() => controller.abort());
    await assert.rejects(synthesizeAnswer({ query: "q", tweets: [post], config, model,
      signal: source !== "deps" ? controller.signal : undefined,
      deps: { signal: source !== "top" ? controller.signal : undefined,
        fetchMedia: async () => { media++; return TEST_IMAGE; },
        complete: async () => { completions++; return "No links"; },
      },
    }), { name: "AbortError" });
    assert.equal(media, 0); assert.equal(completions, 0);
  });
}

test("top-level-only cancellation stops at the first large-selection yield", async () => {
  const controller = new AbortController(), seen = new Set<number>();
  const posts: Tweet[] = Array.from({ length: 100 }, (_, index) => ({
    id: String(index + 1), url: `https://x.com/a/status/${index + 1}`,
    get text() { seen.add(index); return "x"; },
  }));
  const abort = setImmediate(() => controller.abort());
  let completions = 0;
  try {
    await assert.rejects(synthesizeAnswer({ query: "q", tweets: posts, config, model,
      signal: controller.signal, deps: { complete: async () => { completions++; return "No links"; } },
    }), { name: "AbortError" });
    assert.ok(seen.size <= 32, `selection continued past cancellation: ${seen.size} bundles`);
    assert.equal(completions, 0);
  } finally { clearImmediate(abort); }
});

test("top-level signal reaches media and abort after download prevents subsequent work", async () => {
  const controller = new AbortController();
  let media = 0, completions = 0;
  await assert.rejects(synthesizeAnswer({ query: "q", tweets: [post], config, model,
    signal: controller.signal, deps: {
      fetchMedia: async () => { media++; queueMicrotask(() => controller.abort()); return TEST_IMAGE; },
      complete: async () => { completions++; return "No links"; },
    },
  }), { name: "AbortError" });
  assert.equal(media, 1); assert.equal(completions, 0);
});

test("abort at media-to-completion await prevents SDK dispatch", async () => {
  const controller = new AbortController();
  let media = 0, completions = 0;
  await assert.rejects(synthesizeAnswer({ query: "q", tweets: [{ ...post, media: post.media!.slice(0, 1) }], config, model,
    signal: controller.signal, deps: {
      fetchMedia: async () => {
        media++;
        // First microtask precedes fetchImage's continuation; the second precedes
        // the collector's final continuation after its post-fetch abort check.
        queueMicrotask(() => queueMicrotask(() => controller.abort()));
        return TEST_IMAGE;
      },
      complete: async () => { completions++; return "No links"; },
    },
  }), { name: "AbortError" });
  assert.equal(media, 1); assert.equal(completions, 0);
});

test("observer cancellation before image dispatch performs no HTTP work", async () => {
  const controller = new AbortController();
  let media = 0;
  await assert.rejects(synthesizeAnswer({ query: "q", tweets: [post], config, model,
    signal: controller.signal, deps: {
      progress: phase => { if (phase.startsWith("media ")) controller.abort(); },
      fetchMedia: async () => { media++; return TEST_IMAGE; }, complete: async () => "No links",
    },
  }), { name: "AbortError" });
  assert.equal(media, 0);
});

test("caller cancellation after a video processor cannot trigger paid poster fallback", async () => {
  const controller = new AbortController();
  let media = 0, processors = 0, completions = 0;
  const videoConfig = loadTwitterConfig({ twitter: { enableVideoUnderstanding: true, enableVideoProcessing: true, imageInputBounds: { "test/large": TEST_IMAGE_BOUNDS } } });
  await assert.rejects(synthesizeAnswer({ query: "q", tweets: [{ ...post, media: [{ type: "video", url: "https://pbs.twimg.com/poster.jpg", videoVariants: ["https://video.twimg.com/one.mp4"] }] }], config: videoConfig, model,
    signal: controller.signal, deps: {
      processVideo: async input => { processors++; controller.abort(); return { postUrl: input.postUrl, method: "frames-only", frames: [], notes: [] }; },
      fetchMedia: async () => { media++; return TEST_IMAGE; }, complete: async () => { completions++; return "No links"; },
    },
  }), { name: "AbortError" });
  assert.equal(processors, 1); assert.equal(media, 0); assert.equal(completions, 0);
});

test("deps-only effective signal is forwarded to the physical completion", async () => {
  const controller = new AbortController();
  await synthesizeAnswer({ query: "q", tweets: [{ text: "x" }], config, model, deps: {
    signal: controller.signal, complete: async request => { assert.equal(request.signal, controller.signal); return "No links"; },
  } });
});
