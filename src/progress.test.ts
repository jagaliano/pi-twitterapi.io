import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTwitterTool } from "./tool.js";
import { loadTwitterConfig } from "./config.js";
import { runTwitterApiSearch, runTwitterApiProfile } from "./backend.js";
import { reportProgress } from "./progress.js";
import { collectMedia } from "./synthesize.js";
import { searchTweets, normalizeParams, searchUsers, fetchTweetReplies, fetchFollowers } from "./twitterapi.js";
import { processVideo } from "./backend/video.js";
import { TEST_LIMITS, TEST_IMAGE, TEST_IMAGE_BOUNDS } from "./fixtures/budget.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const model = { provider: "test", id: "answer", input: [], ...TEST_LIMITS };
const config = loadTwitterConfig({ twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0, retryBaseDelayMs: 0, maxPages: 2 } });
const raw = (id: string) => ({ id, url: `https://x.com/a/status/${id}`, text: "source" });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const registry = { getAll: () => [model], find: () => model, complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Source https://x.com/a/status/1" }] }) };
const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };

function tool(options: Parameters<typeof registerTwitterTool>[1]) {
  let registered: any;
  registerTwitterTool({ registerTool(value: unknown) { registered = value; } } as ExtensionAPI, options);
  return registered;
}

test("progress orders page counts before physical synthesis and stays out of final markdown", async () => {
  const phases: string[] = [];
  let page = 0;
  const result = await runTwitterApiSearch({ config, params: { query: "source", count: 2 }, env: { TWITTERAPI_IO_API_KEY: "progress-search" }, registry,
    fetcher: async () => response({ tweets: [raw(String(++page))], has_next_page: page === 1, next_cursor: "next" }),
    progress: (text: string) => phases.push(text),
  } as any);
  assert.deepEqual(phases, ["page 1/2 · 0 posts", "page 1/2 · 1 posts", "page 2/2 · 1 posts", "page 2/2 · 2 posts", "synthesizing with test/answer"]);
  assert.ok(!result.markdown.includes("page 1/2") && !result.markdown.includes("synthesizing with"));
});

test("progress covers account and generic tweet/account pagination", async () => {
  for (const kind of ["users", "replies", "followers"] as const) {
    const phases: string[] = []; let page = 0;
    const fetcher = async () => response({ tweets: [raw(String(++page))], users: [{ id: String(page), screen_name: `user${page}` }], followers: [{ id: String(page), screen_name: `user${page}` }], has_next_page: page === 1, next_cursor: "next" });
    const options = { progress: (text: string) => phases.push(text), minRequestIntervalMs: 0, maxPages: 2 } as any;
    if (kind === "users") await searchUsers("a", `progress-${kind}`, fetcher, options);
    if (kind === "replies") await fetchTweetReplies("1", `progress-${kind}`, fetcher, options);
    if (kind === "followers") await fetchFollowers("a", `progress-${kind}`, fetcher, options);
    assert.deepEqual(phases, ["page 1/2 · 0 " + (kind === "replies" ? "posts" : "accounts"), "page 1/2 · 1 " + (kind === "replies" ? "posts" : "accounts"), "page 2/2 · 1 " + (kind === "replies" ? "posts" : "accounts"), "page 2/2 · 2 " + (kind === "replies" ? "posts" : "accounts")]);
  }
});

test("progress forwards lookups and reports every fallback/repair registry invocation", async () => {
  const phases: string[] = []; const fallback = { ...model, id: "fallback" }; let calls = 0;
  await runTwitterApiProfile({ config, query: "profile", userName: "a", env: { TWITTERAPI_IO_API_KEY: "progress-lookup" }, fallbackModelIds: ["test/fallback"],
    progress: (text: string) => phases.push(text), fetcher: async () => response({ data: { userName: "a", name: "A" } }),
    registry: { getAll: () => [model, fallback], find: () => model, complete: async () => {
      if (++calls === 1) throw new Error("HTTP 404 unknown model");
      if (calls === 2) throw new Error("Invalid reasoning_effort: unsupported. Supported values: [low, high]");
      return { stopReason: "stop", content: [{ type: "text", text: "Profile https://x.com/a" }] };
    } },
  } as any);
  assert.deepEqual(phases, ["reading X", "synthesizing with test/answer", "synthesizing with test/fallback", "synthesizing with test/fallback"]);
});

test("progress gives deduplicated media attempt positions and passes through the video processor", async () => {
  const phases: string[] = [];
  const photo = { type: "photo", url: "https://pbs.twimg.com/p.jpg" };
  const video = { type: "video", url: "https://pbs.twimg.com/v.jpg", videoVariants: ["https://video.twimg.com/v.mp4"] };
  const mediaConfig = { ...config, enableImageUnderstanding: true, enableVideoUnderstanding: true, enableVideoProcessing: true };
  const deps = { progress: (text: string) => phases.push(text), fetchMedia: async () => TEST_IMAGE,
    processVideo: async () => { phases.push("processor entered"); return { postUrl: "", method: "frames-only" as const, frames: [], notes: [] }; },
  };
  await collectMedia([{ ...raw("1"), media: [video, photo, photo] }], mediaConfig, { ...model, supportsImage: true }, deps as any);
  assert.deepEqual(phases, ["media 1/2", "media 2/2", "processor entered", "media 2/2"]);
});

test("progress video phases reflect native failure then real frames/audio fallback", async () => {
  const phases: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "twitter-progress-"));
  try {
    const videoConfig = loadTwitterConfig({ twitter: { enableVideoProcessing: true, videoModel: "test-native", videoApiKeyEnv: "TEST_NATIVE", sttEndpoint: "https://stt.example/v1", sttModel: "whisper", sttApiKeyEnv: "TEST_STT", maxFrames: 1 } });
    const result = await processVideo({ config: videoConfig, deadline: Date.now() + 15_000, postUrl: "https://x.com/a/status/1", modelSupportsImage: true,
      media: { type: "video", durationMillis: 5_000, videoVariants: ["https://video.twimg.com/test.mp4"] },
      deps: { progress: (text: string) => phases.push(text), env: { TEST_NATIVE: "fake-native", TEST_STT: "fake-stt" }, mktemp: async () => dir, rmTemp: async () => {}, checkBinary: async () => true,
        exec: async (_, args) => { await writeFile(args.at(-1)!, "fixture"); return { stdout: "", stderr: "" }; },
        fetcher: async (input, init) => {
          if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "10" } });
          if (String(input).includes("video.twimg.com")) return new Response("fixture", { headers: { "content-type": "video/mp4" } });
          if (String(input).includes("generativelanguage")) return response({ promptFeedback: { blockReason: "SAFETY" } });
          return response({ text: "We discuss concrete implementation details and regression testing in this short clip." });
        },
      },
    });
    assert.ok(result.transcript); assert.equal(result.frames.length, 1);
    assert.deepEqual(phases, ["video: downloading", "video: native analysis", "video: frames", "video: transcribing"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("progress tool updates render the latest phase and do not contaminate final details", async () => {
  const registered = tool({ settings: { twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0 } }, env: { TWITTERAPI_IO_API_KEY: "progress-tool" }, fetcher: async () => response({ tweets: [raw("1")] }) });
  const updates: any[] = [];
  const result = await registered.execute("one", { query: "q", mode: "tweets", ids: ["1"] }, undefined, (value: any) => updates.push(value), { modelRegistry: registry });
  assert.deepEqual(updates.map(x => x.content[0].text), ["reading X", "synthesizing with test/answer"]);
  const component = registered.renderResult(updates.at(-1), { isPartial: true }, theme, {});
  assert.match(component.render(120).join("\n"), /synthesizing with test\/answer/);
  assert.equal(result.details.progress, undefined);
});

test("progress expands page ceiling for padded-date free pages", async () => {
  const phases: string[] = []; let page = 0;
  const result = await searchTweets(normalizeParams({ query: "q", from_date: "2026-03-01", to_date: "2026-03-01" }), "progress-padding", async () => response({ tweets: [{ ...raw(String(++page)), createdAt: page === 1 ? "2026-03-02T02:00:00Z" : "2026-03-01T14:00:00Z" }], has_next_page: page === 1, next_cursor: "next" }), { progress: text => { phases.push(text); }, minRequestIntervalMs: 0, maxPages: 1, maxPagesCeiling: 3, localUtcOffsetMinutes: 0 });
  assert.equal(result.pagesFetched, 2);
  assert.deepEqual(phases, ["page 1/3 · 0 posts", "page 1/3 · 0 posts", "page 2/3 · 0 posts", "page 2/3 · 1 posts"]);
});

test("progress crosses tool/backend media dependencies in actual collection order", async () => {
  const imageModel = { ...model, input: ["image"] };
  const registered = tool({ settings: { twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0, enableImageUnderstanding: true, imageInputBounds: { "test/answer": TEST_IMAGE_BOUNDS } } }, env: { TWITTERAPI_IO_API_KEY: "progress-tool-media" }, fetcher: async input => String(input).includes("pbs.twimg.com") ? new Response(Buffer.from(TEST_IMAGE.data, "base64"), { headers: { "content-type": "image/png" } }) : response({ tweets: [{ ...raw("1"), extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/photo.png" }] } }] }) });
  const phases: string[] = [];
  await registered.execute("media", { query: "q", mode: "tweets", ids: ["1"] }, undefined, (value: any) => phases.push(value.content[0].text), { modelRegistry: { ...registry, getAll: () => [imageModel], find: () => imageModel } });
  assert.deepEqual(phases, ["reading X", "media 1/1", "synthesizing with test/answer"]);
});

test("progress asynchronous observer rejection is display-only", async () => {
  let observed = 0;
  const result = await runTwitterApiSearch({ config, params: { query: "q" }, registry, env: { TWITTERAPI_IO_API_KEY: "progress-async-errors" }, fetcher: async () => response({ tweets: [raw("1")] }), progress: async () => { observed++; throw new Error("observer only"); } });
  assert.ok(observed > 0); assert.ok(result.details.text);
});

test("progress exceptions cannot prevent paid work or turn a successful answer into failure", async () => {
  let observed = 0;
  const result = await runTwitterApiSearch({ config, params: { query: "q" }, registry, env: { TWITTERAPI_IO_API_KEY: "progress-errors" }, fetcher: async () => response({ tweets: [raw("1")] }), progress: () => { observed++; throw new Error("observer only"); } } as any);
  assert.ok(observed > 0); assert.ok(result.details.text);
});

test("progress reporter refuses notifications from dependencies finishing after abort", () => {
  const controller = new AbortController(); const phases: string[] = [];
  controller.abort();
  reportProgress({ signal: controller.signal, progress: text => { phases.push(text); } }, "late phase");
  assert.deepEqual(phases, []);
});

test("progress cancellation suppresses late media/video/complete updates", async () => {
  const controller = new AbortController(); const phases: string[] = [];
  const registered = tool({ settings: { twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0 } }, env: { TWITTERAPI_IO_API_KEY: "progress-cancel" }, fetcher: async () => { controller.abort(); return response({ tweets: [raw("1")] }); } });
  await assert.rejects(registered.execute("cancel", { query: "q", mode: "tweets", ids: ["1"] }, controller.signal, (value: any) => phases.push(value.content[0].text), { modelRegistry: registry }));
  assert.deepEqual(phases, ["reading X"]);
});
