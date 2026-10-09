import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { loadTwitterConfig } from "./config.js";
import { registerTwitterTool } from "./tool.js";
import { formatTwitterResults } from "./format.js";
import { runTwitterApiSearch, runTwitterApiTweetsByIds, runTwitterApiProfile, runTwitterApiUserTimeline, runTwitterApiUserSearch, runTwitterApiTrends, runTwitterApiAbout } from "./backend.js";
import { TEST_LIMITS, TEST_IMAGE, TEST_IMAGE_BOUNDS } from "./fixtures/budget.js";
import { RunTelemetry } from "./telemetry.js";
import { processVideo } from "./backend/video.js";

const model = { provider: "test", id: "answer", input: [], ...TEST_LIMITS };
const config = loadTwitterConfig({ twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0, retryBaseDelayMs: 0 } });
const raw = (id: string, text = "source") => ({ id, url: `https://x.com/a/status/${id}`, text });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const registry = { getAll: () => [model], find: () => model, complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Source https://x.com/a/status/1" }], usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 3, totalTokens: 19 } }) };
let credential = 0;
const env = () => ({ TWITTERAPI_IO_API_KEY: `telemetry-${++credential}` });
const timings = (result: any) => {
  const t = result.details.timings;
  assert.ok(t && Object.values(t).every(value => typeof value === "number" && Number.isFinite(value) && value >= 0));
  assert.ok(Math.abs(t.totalMs - t.retrievalMs - t.preprocessingMs - t.synthesisMs) < 0.00001);
  assert.ok(t.videoMs <= t.preprocessingMs + 0.00001, "video is nested, not added to disjoint total");
};

test("telemetry counts real retry invocations, accepted pages and discarded raw posts", async () => {
  let attempts = 0;
  const result = await runTwitterApiSearch({ config, params: { query: "q", count: 1 }, env: env(), registry, fetcher: async () => ++attempts === 1 ? response({ detail: "retry" }, 503) : response({ tweets: [raw("1"), raw("1"), {}, raw("2")] }) });
  const u = (result.details as any).usage;
  assert.equal(u.upstreamAttempts, attempts); assert.equal(u.upstreamHttpFailures, 1); assert.equal(u.successfulPages, 1);
  assert.equal(u.postsReturned, 4); assert.equal(u.postsRetained, 1);
  assert.equal(u.synthesisAttempts, 1); assert.equal(u.synthesisFailures, 0);
  assert.deepEqual(u.synthesisTokens, { reportedCalls: 1, input: 10, output: 4, cacheRead: 2, cacheWrite: 3, totalTokens: 19 });
  timings(result);
  const { usage, timings: ignored, ...old } = result.details as any;
  assert.equal(result.markdown, formatTwitterResults(old), "instrumentation is not model-visible markdown");
});

test("telemetry retained roots follow actual input selection rather than retrieval limit", async () => {
  const small = loadTwitterConfig({ twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0, maxSynthesisChars: 5_000 } });
  const result = await runTwitterApiSearch({ config: small, params: { query: "q", count: 10 }, env: env(), registry, fetcher: async () => response({ tweets: Array.from({ length: 10 }, (_, i) => raw(String(i + 1), "x".repeat(700))) }) });
  const u = (result.details as any).usage;
  assert.equal(u.postsReturned, 10); assert.ok(u.postsRetained > 0 && u.postsRetained < 10);
  assert.ok(result.details.notes?.some(x => /input budget/.test(x))); timings(result);
});

test("telemetry records every fallback and reasoning repair while missing usage stays unknown", async () => {
  const fallback = { ...model, id: "fallback" }; let attempts = 0;
  const result = await runTwitterApiTweetsByIds({ config, query: "q", ids: ["1"], env: env(), fallbackModelIds: ["test/fallback"], fetcher: async () => response({ tweets: [raw("1")] }), registry: { getAll: () => [model, fallback], find: () => model, complete: async () => {
    if (++attempts === 1) throw new Error("HTTP 404 unknown model");
    if (attempts === 2) throw new Error("Invalid reasoning_effort: unsupported. Supported values: [low, high]");
    return { stopReason: "stop", content: [{ type: "text", text: "Source https://x.com/a/status/1" }], usage: { input: 5 } };
  } } });
  const u = (result.details as any).usage;
  assert.equal(u.synthesisAttempts, 3); assert.equal(u.synthesisFailures, 2);
  assert.deepEqual(u.synthesisTokens, { reportedCalls: 1, input: 5 });
  assert.equal(result.details.synthesisCalls, 1, "legacy logical-success counter is unchanged");
});

test("telemetry includes usage on failed SDK messages and failed photo requests", async () => {
  const imageModel = { ...model, input: ["image"] }, fallback = { ...model, id: "fallback" }; let calls = 0;
  const mediaConfig = loadTwitterConfig({ twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0, enableImageUnderstanding: true, imageInputBounds: { "test/answer": TEST_IMAGE_BOUNDS } } });
  const result = await runTwitterApiTweetsByIds({ config: mediaConfig, query: "q", ids: ["1"], env: env(), fallbackModelIds: ["test/fallback"], fetcher: async input => {
    if (String(input).includes("failed.png")) return response({}, 500);
    if (String(input).includes("pbs.twimg.com")) return new Response(Buffer.from(TEST_IMAGE.data, "base64"), { headers: { "content-type": "image/png" } });
    return response({ tweets: [{ ...raw("1"), extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/failed.png" }, { type: "photo", media_url_https: "https://pbs.twimg.com/good.png" }] } }] });
  }, registry: { getAll: () => [imageModel, fallback], find: () => imageModel, complete: async () => ++calls === 1 ? { stopReason: "error", errorMessage: "HTTP 404 unknown model", usage: { input: 7 }, content: [] } : { stopReason: "stop", usage: { input: 11, output: 2 }, content: [{ type: "text", text: "Source https://x.com/a/status/1" }] } } });
  const u = (result.details as any).usage;
  assert.equal(u.mediaAttempts, 2); assert.equal(u.mediaHeadAttempts, 0); assert.equal(u.mediaHttpFailures, 1);
  assert.equal(u.synthesisAttempts, 2); assert.equal(u.synthesisFailures, 1);
  assert.deepEqual(u.synthesisTokens, { reportedCalls: 2, input: 18, output: 2 }); timings(result);
});

test("telemetry separates native lifecycle requests, STT format retries and media probes", async () => {
  const imageModel = { ...model, input: ["image"] }; let stt = 0;
  const videoConfig = loadTwitterConfig({ twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0, enableImageUnderstanding: true, enableVideoUnderstanding: true, enableVideoProcessing: true, ffmpegPath: process.execPath, maxFrames: 1, videoEndpointType: "openai-compatible", videoEndpoint: "https://video.example/v1", videoApiKeyEnv: "TEST_VIDEO", videoModel: "video-model", sttEndpoint: "https://stt.example/v1", sttModel: "whisper", sttApiKeyEnv: "TEST_STT", imageInputBounds: { "test/answer": TEST_IMAGE_BOUNDS } } });
  const result = await runTwitterApiTweetsByIds({ config: videoConfig, query: "q", ids: ["1"], env: { ...env(), TEST_VIDEO: "fake", TEST_STT: "fake" }, registry: { ...registry, getAll: () => [imageModel], find: () => imageModel }, videoExec: async (_, args) => { if (args.at(-1)!.startsWith("-")) return { stdout: "test version", stderr: "" }; await writeFile(args.at(-1)!, "fixture"); return { stdout: "", stderr: "" }; }, fetcher: async (input, init) => {
    const url = String(input);
    if (url.includes("api.twitterapi.io")) return response({ tweets: [{ ...raw("1"), extended_entities: { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/poster.jpg", video_info: { duration_millis: 1_000, variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/clip.mp4" }] } }] } }] });
    if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "7" } });
    if (url.includes("video.twimg.com")) return new Response("fixture", { headers: { "content-type": "video/mp4" } });
    if (url.includes("video.example")) return response({ error: { message: "unavailable" } }, 503);
    if (url.includes("stt.example")) return ++stt < 3 ? response({ error: "response_format unsupported" }, 400) : new Response("We discuss implementation details and concrete regression testing in this short clip.");
    return response({}, 500);
  } });
  const u = (result.details as any).usage;
  assert.equal(u.nativeVideoAttempts, 1); assert.equal(u.nativeVideoHttpFailures, 1);
  assert.equal(u.sttAttempts, 3); assert.equal(u.sttHttpFailures, 2);
  assert.equal(u.mediaHeadAttempts, 1); assert.ok(u.mediaAttempts >= 2); assert.equal(u.upstreamAttempts, 1);
  assert.equal(u.synthesisAttempts, 1); assert.ok((result.details as any).timings.videoMs > 0); timings(result);
});

test("telemetry uses disjoint timings including SDK retry backoff and nested video time", async () => {
  let now = 0, calls = 0;
  const imageModel = { ...model, input: ["image"] };
  const c = loadTwitterConfig({ twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0, enableImageUnderstanding: true, imageInputBounds: { "test/answer": TEST_IMAGE_BOUNDS } } });
  const result = await runTwitterApiTweetsByIds({ config: c, query: "q", ids: ["1"], env: env(), telemetryNow: () => now, synthesisSleep: async () => { now += 50; }, fetcher: async input => {
    if (String(input).includes("pbs.twimg.com")) { now += 30; return new Response(Buffer.from(TEST_IMAGE.data, "base64"), { headers: { "content-type": "image/png" } }); }
    now += 10; return response({ tweets: [{ ...raw("1"), extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/p.png" }] } }] });
  }, registry: { ...registry, find: () => imageModel, getAll: () => [imageModel], complete: async () => { now += 20; if (++calls === 1) throw new Error("HTTP 503 unavailable"); return { stopReason: "stop", content: [{ type: "text", text: "Source https://x.com/a/status/1" }] }; } } });
  assert.deepEqual(result.details.timings, { totalMs: 130, retrievalMs: 10, preprocessingMs: 30, synthesisMs: 90, videoMs: 0 });
  assert.equal((result.details as any).usage.synthesisTokens, undefined);
});

test("telemetry is isolated per call even when credentials and registry are shared", async () => {
  const sharedEnv = env();
  const results = await Promise.all([1, 2].map(count => runTwitterApiSearch({ config, params: { query: String(count), count }, env: sharedEnv, registry, fetcher: async () => response({ tweets: Array.from({ length: count }, (_, i) => raw(String(i + 1))) }) })));
  assert.equal((results[0].details as any).usage.postsReturned, 1); assert.equal((results[1].details as any).usage.postsReturned, 2);
  assert.equal((results[0].details as any).usage.upstreamAttempts, 1); assert.equal((results[1].details as any).usage.upstreamAttempts, 1);
});

test("telemetry covers account, trend, nested timeline, empty and document paths", async () => {
  const cases: [Function, object, unknown, string, number, number][] = [
    [runTwitterApiUserSearch, { query: "q" }, { users: [{ userName: "a" }, { userName: "a" }] }, "accounts", 2, 1],
    [runTwitterApiProfile, { query: "q", userName: "a" }, { data: { userName: "a" } }, "accounts", 1, 1],
    [runTwitterApiUserTimeline, { query: "q", userName: "a", limit: 1 }, { data: { tweets: [raw("1"), raw("2")], pin_tweet: null } }, "posts", 2, 1],
    [runTwitterApiTrends, { query: "q", woeid: 1 }, { trends: [] }, "trends", 0, 0],
    [runTwitterApiTrends, { query: "q", woeid: 1 }, { trends: [{ trend: { name: "topic" } }, { trend: { name: "topic" } }] }, "trends", 2, 1],
    [runTwitterApiAbout, { query: "q", userName: "a" }, { userName: "a", about_profile: { account_based_in: "Test" } }, "posts", 0, 0],
  ];
  for (const [run, args, payload, kind, count, retained] of cases) {
    const result = await run({ config, registry, env: env(), fetcher: async () => response(payload), ...args });
    assert.equal(result.details.usage.upstreamAttempts, 1); assert.equal(result.details.usage.successfulPages, 1);
    assert.equal(result.details.usage[kind + "Returned"], count);
    assert.equal(result.details.usage[kind + "Retained"], retained); timings(result);
    if (run === runTwitterApiAbout) {
      assert.equal(result.details.usage.accountsReturned, 1);
      assert.equal(result.details.usage.accountsRetained, 0, "document fields are not account-prompt roots");
    }
  }
});

test("telemetry counts Gemini Files upload/poll/generate/delete as separate provider fetches", async () => {
  const telemetry = new RunTelemetry(); telemetry.phase("preprocessingMs");
  let native = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "7" } });
    if (String(input).includes("video.twimg.com")) return new Response("fixture", { headers: { "content-type": "video/mp4" } });
    native++;
    if (native === 1) return new Response(null, { headers: { "x-goog-upload-url": "https://gen.example/upload/job" } });
    if (native === 2) return response({ file: { name: "files/unit", uri: "https://gen.example/files/unit", state: "PROCESSING" } });
    if (native === 3) return response({ name: "files/unit", uri: "https://gen.example/files/unit", state: "ACTIVE" });
    if (native === 4) return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({ visualNotes: "test visual", transcript: "test speech" }) }] } }] });
    if (native === 5) { assert.equal(init?.method, "DELETE"); return new Response(null, { status: 200 }); }
    assert.ok(String(input).endsWith(":generateContent"));
    return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({ visualNotes: "inline visual", transcript: "inline speech" }) }] } }] });
  };
  const c = loadTwitterConfig({ twitter: { enableVideoProcessing: true, videoModel: "video", videoEndpoint: "https://gen.example", videoApiKeyEnv: "TEST_VIDEO", enableAudioTranscription: false } });
  const evidence = await processVideo({ postUrl: "https://x.com/a/status/1", config: c, modelSupportsImage: true, deadline: Date.now() + 15_000, media: { type: "video", durationMillis: 1_000, videoVariantsDetailed: [{ url: "https://video.twimg.com/clip.mp4" }] }, deps: { telemetry, fetcher: telemetry.fetcher(fetcher, "media"), nativeFetcher: telemetry.fetcher(fetcher, "nativeVideo"), inlineRawBytes: 1, env: { TEST_VIDEO: "fake" }, checkBinary: async () => true } });
  assert.equal(evidence.method, "gemini-native"); assert.equal(native, 5);
  assert.equal(telemetry.usage.nativeVideoAttempts, 5); assert.equal(telemetry.usage.nativeVideoHttpFailures, 0);
  assert.equal(telemetry.usage.mediaAttempts, 2); assert.equal(telemetry.usage.mediaHeadAttempts, 1);
  assert.ok(telemetry.snapshot().timings.videoMs > 0);
  const inline = await processVideo({ postUrl: "https://x.com/a/status/1", config: c, modelSupportsImage: true, deadline: Date.now() + 15_000, media: { type: "video", durationMillis: 1_000, videoVariantsDetailed: [{ url: "https://video.twimg.com/clip.mp4" }] }, deps: { telemetry, fetcher: telemetry.fetcher(fetcher, "media"), nativeFetcher: telemetry.fetcher(fetcher, "nativeVideo"), inlineRawBytes: 1_000, env: { TEST_VIDEO: "fake" }, checkBinary: async () => true } });
  assert.equal(inline.method, "gemini-native"); assert.equal(native, 6); assert.equal(telemetry.usage.nativeVideoAttempts, 6);
  assert.equal(telemetry.usage.mediaAttempts, 4);
});

test("telemetry accounts for rejected fetches and Request methods without changing errors", async () => {
  const telemetry = new RunTelemetry(), failure = new Error("transport failure");
  const fetcher = telemetry.fetcher(async () => { throw failure; }, "media");
  await assert.rejects(fetcher(new Request("https://pbs.twimg.com/photo", { method: "HEAD" })), error => error === failure);
  assert.equal(telemetry.usage.mediaAttempts, 1); assert.equal(telemetry.usage.mediaHeadAttempts, 1); assert.equal(telemetry.usage.mediaHttpFailures, 1);
  await telemetry.fetcher(async () => response({}, 503), "nativeVideo")("https://shared.example/v1");
  await telemetry.fetcher(async () => response({}, 400), "stt")("https://shared.example/v1");
  assert.equal(telemetry.usage.nativeVideoAttempts, 1); assert.equal(telemetry.usage.sttAttempts, 1);
});

test("telemetry marks preprocessing for every synthesis family", async () => {
  const cases: [Function, object, unknown][] = [
    [runTwitterApiTweetsByIds, { query: "q", ids: ["1"] }, { tweets: [raw("1")] }],
    [runTwitterApiProfile, { query: "q", userName: "a" }, { data: { userName: "a" } }],
    [runTwitterApiTrends, { query: "q", woeid: 1 }, { trends: [{ trend: { name: "topic" } }] }],
    [runTwitterApiAbout, { query: "q", userName: "a" }, { userName: "a", about_profile: { account_based_in: "Test" } }],
  ];
  for (const [run, args, payload] of cases) {
    let clock = 0;
    const result = await run({ config, registry, env: env(), telemetryNow: () => clock++, fetcher: async () => response(payload), ...args });
    assert.deepEqual(result.details.timings, { totalMs: 4, retrievalMs: 1, preprocessingMs: 2, synthesisMs: 1, videoMs: 0 });
  }
});

test("telemetry accepts only finite reported token fields without inventing cost or unknown zeroes", () => {
  const telemetry = new RunTelemetry();
  telemetry.tokens({ usage: { input: -1, output: NaN, cacheRead: Infinity, cost: 100 } });
  assert.equal(telemetry.usage.synthesisTokens, undefined);
  telemetry.tokens({ usage: { input: 0, output: 3, totalTokens: 3, cost: 100 } });
  assert.deepEqual(telemetry.usage.synthesisTokens, { reportedCalls: 1, input: 0, output: 3, totalTokens: 3 });
  const snapshot = telemetry.snapshot(); snapshot.usage.synthesisTokens!.input = 9;
  assert.equal(telemetry.snapshot().usage.synthesisTokens!.input, 0, "snapshots cannot mutate another result");
});

test("telemetry ignores broken optional SDK metadata without adding a retry", async () => {
  let calls = 0;
  const result = await runTwitterApiTweetsByIds({ config, query: "q", ids: ["1"], env: env(), fetcher: async () => response({ tweets: [raw("1")] }), registry: { ...registry, complete: async () => { calls++; return { stopReason: "stop", content: [{ type: "text", text: "Source https://x.com/a/status/1" }], get usage() { throw new Error("metadata unavailable"); } }; } } });
  assert.equal(calls, 1); assert.equal((result.details as any).usage.synthesisAttempts, 1);
  assert.equal((result.details as any).usage.synthesisTokens, undefined); assert.equal((result.details as any).usage.synthesisFailures, 0);
});

test("telemetry appears only in expanded tool view and never changes final content", async () => {
  let registered: any;
  registerTwitterTool({ registerTool(value: unknown) { registered = value; } } as any, { settings: { twitter: { synthesisModel: "test/answer", minRequestIntervalMs: 0 } }, env: env(), fetcher: async () => response({ tweets: [raw("1")] }) });
  const result = await registered.execute("one", { query: "q", mode: "tweets", ids: ["1"] }, undefined, undefined, { modelRegistry: registry });
  initTheme("dark", false);
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  const render = (expanded: boolean) => registered.renderResult(result, { expanded }, theme, {}).render(200).join("\n");
  assert.ok(!render(false).includes("Usage:")); assert.match(render(true), /Usage:.*upstream 1/); assert.match(render(true), /Timings.*video.*nested/);
  assert.ok(!result.content[0].text.includes("Usage:"));
});
