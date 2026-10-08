import assert from "node:assert/strict";
import test from "node:test";
import { loadTwitterConfig } from "./config.js";
import { InputBudget, imageDimensions, renderedPrompt, withoutImages } from "./input-budget.js";
import { resolveSynthesisBackend, runTwitterApiProfile, runTwitterApiSearch, runTwitterApiUserSearch, runTwitterApiTrends, runTwitterApiAbout, type RegistryLike } from "./backend.js";
import { synthesizeAnswer, synthesizeUserAnswer, synthesizeTrends, synthesizeDocument, type SynthesisModel, type SynthesisRequest } from "./synthesize.js";
import type { Tweet, UserProfile } from "./twitterapi.js";
import { TEST_LIMITS, TEST_IMAGE, TEST_IMAGE_BOUNDS } from "./fixtures/budget.js";
const MODEL: SynthesisModel = { ...TEST_LIMITS, provider: "test", id: "budget", supportsImage: true };
const now = () => Date.UTC(2026, 9, 8, 12);
const post = (n: number, extra: Partial<Tweet> = {}): Tweet => ({ id: String(n), url: `https://x.com/source/status/${n}`, text: "text", createdAt: "", author: { userName: "source" }, ...extra });
const config = (extra: Record<string, unknown> = {}) => loadTwitterConfig({ twitter: { enableImageUnderstanding: true, enableVideoUnderstanding: true, enableVideoProcessing: true, minRequestIntervalMs: 0, imageInputBounds: { "test/budget": TEST_IMAGE_BOUNDS }, ...extra } });
const fakeRegistry = (models: object[], complete: (...args: any[]) => Promise<unknown>): RegistryLike => ({ getAll: () => models, find: () => undefined, complete }) as unknown as RegistryLike;

test("budget settings are clamped and image declarations are user-only", () => {
  const cfg = loadTwitterConfig({ twitter: { maxSynthesisChars: Infinity, imageInputBounds: { "test/budget": TEST_IMAGE_BOUNDS, "bad": TEST_IMAGE_BOUNDS, "test/broken": { tokensPerImage: NaN } } } }, { projectSettings: { twitter: { imageInputBounds: { "test/project": TEST_IMAGE_BOUNDS } } } });
  assert.equal(cfg.maxSynthesisChars, 60_000);
  assert.deepEqual(Object.keys(cfg.imageInputBounds!), ["test/budget"]);
  assert.ok(cfg.configNotes.some(note => note.includes("user settings only")));
  assert.ok(cfg.configNotes.some(note => note.includes("maxSynthesisChars")));
  assert.equal(loadTwitterConfig({ twitter: { maxSynthesisChars: 999_999 } }).maxSynthesisChars, 120_000);
  assert.equal(config({ imageInputBounds: { "test/budget": { ...TEST_IMAGE_BOUNDS, tokensPerImage: 2_000_000 } } }).imageInputBounds!["test/budget"].tokensPerImage, 2_000_000, "a token upper bound must never be clamped downward");
});

test("UTF-8 bytes, system, question, manifest and output all consume the budget", () => {
  const budget = new InputBudget([{ ...MODEL, contextWindow: 5_000, maxTokens: 1_000 }]);
  assert.equal(budget.fits({ system: "s", prompt: "a".repeat(2_000), images: [] }), true);
  assert.equal(budget.fits({ system: "s", prompt: "界".repeat(2_000), images: [] }), false);
  assert.equal(budget.fits({ system: "s".repeat(4_000), prompt: "q", images: [] }), false);
  assert.equal(budget.fits({ system: "s", prompt: "a".repeat(3_500), images: [] }), false, "output reservation is not spendable input");
  const imageCost = new InputBudget([{ ...MODEL, contextWindow: 18_000, maxTokens: 1_000 }], 60_000, { "test/budget": { ...TEST_IMAGE_BOUNDS, tokensPerImage: 17_000 } });
  assert.equal(imageCost.fits({ system: "s", prompt: "q", images: [TEST_IMAGE] }), false, "declared image tokens consume context");
  const imageBudget = new InputBudget([MODEL], 60_000, { "test/budget": TEST_IMAGE_BOUNDS });
  assert.equal(imageBudget.fits({ system: "s", prompt: "q", images: [TEST_IMAGE], mediaManifest: "x".repeat(60_000) }), false);
  assert.equal(renderedPrompt({ prompt: "q", images: [], mediaManifest: "not delivered" }), "q");
});

test("unknown catalogue limits and oversize questions fail before upstream retrieval", async () => {
  for (const [limits, query] of [[{}, "q"], [{ contextWindow: Infinity, maxTokens: 10 }, "q"], [TEST_LIMITS, "q".repeat(70_000)], [{ contextWindow: 8_000, maxTokens: 1_000 }, "界".repeat(3_000)]] as const) {
    let upstream = 0, synthesis = 0;
    const registry = fakeRegistry([{ provider: "test", id: "budget", input: ["text"], ...limits }], async () => { synthesis++; return "unexpected"; });
    const options = { config: config({ synthesisModel: "test/budget" }), env: { TWITTERAPI_IO_API_KEY: "budget-early" }, registry, fetcher: (async () => { upstream++; return new Response("{}"); }) as typeof fetch };
    await assert.rejects(runTwitterApiSearch({ ...options, params: { query } }), /input budget/);
    await assert.rejects(runTwitterApiProfile({ ...options, query, userName: "source" }), /input budget/);
    assert.equal(upstream, 0); assert.equal(synthesis, 0);
  }
});

for (const mode of ["posts", "accounts", "trends", "documents"] as const) {
  test(`oversized image-reference-shaped question pays no retrieval/completion in ${mode}`, async () => {
    const query = "q\n" + "image references: 1 (only if images delivered)\n".repeat(2_000);
    let upstream = 0, completions = 0;
    const registry = fakeRegistry([{ ...TEST_LIMITS, provider: "test", id: "budget", input: ["text"] }], async () => { completions++; return { content: [{ type: "text", text: "unexpected" }] }; });
    const options = { query, config: config({ synthesisModel: "test/budget" }), env: { TWITTERAPI_IO_API_KEY: `question-boundary-${mode}` }, registry, fetcher: (async () => { upstream++; return Response.json({ tweets: [{ id: "1", url: "https://x.com/source/status/1", text: "text" }], users: [{ userName: "source" }], trends: [{ name: "trend", query: "trend" }], data: { userName: "source" } }); }) as typeof fetch };
    const call = mode === "posts" ? runTwitterApiSearch({ ...options, params: { query } }) : mode === "accounts" ? runTwitterApiUserSearch(options) : mode === "trends" ? runTwitterApiTrends({ ...options, woeid: 1 }) : runTwitterApiAbout({ ...options, userName: "source" });
    await assert.rejects(call, /input budget/);
    assert.equal(upstream, 0); assert.equal(completions, 0);
  });
}

test("image-free physical measurements preserve reference-shaped question lines in every path", async () => {
  const query = "q\n" + "image references: 1 (only if images delivered)\n".repeat(2_000);
  const budget = new InputBudget([MODEL]);
  assert.equal(budget.fits({ system: "s", prompt: query, images: [] }), false);
  let calls = 0;
  const deps = { inputBudget: budget, now, complete: async () => { calls++; return "unexpected"; } };
  await assert.rejects(synthesizeAnswer({ query, tweets: [post(1)], config: config(), model: MODEL, deps }), /input budget/);
  await assert.rejects(synthesizeUserAnswer({ query, users: [{ handle: "source", name: "Name", profileUrl: "https://x.com/source" }], config: config(), model: MODEL, deps }), /input budget/);
  await assert.rejects(synthesizeTrends({ query, trends: [{ name: "trend", query: "trend" }], model: MODEL, deps }), /input budget/);
  await assert.rejects(synthesizeDocument({ query, title: "Metadata", body: "field: value", citations: ["https://x.com/source"], model: MODEL, deps }), /input budget/);
  assert.equal(calls, 0);
});

test("the smallest fallback context constrains selection before any model call", async () => {
  const small = { ...MODEL, id: "small", supportsImage: false, contextWindow: 14_000, maxTokens: 1_000 };
  const budget = new InputBudget([MODEL, small]);
  const seen: SynthesisRequest[] = [];
  const tweets = Array.from({ length: 12 }, (_, i) => post(i + 1, { text: "界".repeat(700), quoted: post(i + 101, { text: "quoted " + "界".repeat(700) }) }));
  const details = await synthesizeAnswer({ query: "q", tweets, config: config(), model: MODEL, deps: { inputBudget: budget, now, complete: async request => { seen.push(request); budget.assert(request); return "no inline citations"; } } });
  assert.equal(seen.length, 1);
  const delivered = Number(seen[0].prompt.match(/Posts \((\d+)\)/)?.[1]);
  assert.ok(delivered > 0 && delivered < tweets.length);
  assert.equal(seen[0].prompt.match(/^quoted source:/gm)?.length, delivered);
  assert.equal(details.citations.length, delivered * 2);
  assert.ok(details.notes?.some(note => /locally/.test(note)));
  assert.equal(seen[0].maxTokens, 1_000);
});

test("omitted whole post bundles incur no media or video calls", async () => {
  const chosen = post(1, { media: [{ type: "photo", url: "https://pbs.twimg.com/kept.png" }] });
  const omitted = post(2, { media: Array.from({ length: 8 }, (_, i) => ({ type: "video", url: `https://pbs.twimg.com/omitted${i}.png`, altText: "界".repeat(1_000) })), quoted: post(302, { text: "q".repeat(700), media: Array.from({ length: 8 }, (_, i) => ({ type: "photo", url: `https://pbs.twimg.com/quoted${i}.png`, altText: "x".repeat(400) })) }) });
  const downloads: string[] = []; let videos = 0;
  const details = await synthesizeAnswer({ query: "q", tweets: [chosen, omitted], config: config({ maxSynthesisChars: 8_000 }), model: MODEL, deps: {
    now, fetchMedia: async url => { downloads.push(url); return TEST_IMAGE; }, processVideo: async input => { videos++; return { postUrl: input.postUrl, method: "frames-only", frames: [], notes: [] }; },
    complete: async request => { assert.ok(!request.prompt.includes(omitted.url!)); return "no links"; },
  } });
  assert.deepEqual(downloads, ["https://pbs.twimg.com/kept.png"]); assert.equal(videos, 0);
  assert.deepEqual(details.citations, [chosen.url]);
  assert.ok(details.notes?.some(note => /omitted 1 retrieved post bundle/.test(note)));
});

test("unknown image bounds skip downloads but retain native transcript evidence", async () => {
  let downloads = 0, videos = 0;
  const details = await synthesizeAnswer({ query: "q", tweets: [post(1, { media: [{ type: "photo", url: "https://pbs.twimg.com/photo.png" }, { type: "video", url: "https://pbs.twimg.com/poster.png" }] })], config: config({ imageInputBounds: {} }), model: MODEL, deps: {
    now, fetchMedia: async () => { downloads++; return TEST_IMAGE; }, processVideo: async input => { videos++; assert.equal(input.allowFrames, false); return { postUrl: input.postUrl, method: "openai-compatible", transcript: "actual speech", frames: [], notes: [] }; },
    complete: async request => { assert.equal(request.images.length, 0); assert.equal(request.mediaManifest, undefined); assert.match(request.prompt, /actual speech/); return "ok"; },
  } });
  assert.equal(downloads, 0); assert.equal(videos, 1);
  assert.ok(details.notes?.some(note => /no explicit imageInputBounds/.test(note)));
});

test("unreserved video assets never reach the processor", async () => {
  let videos = 0;
  const details = await synthesizeAnswer({ query: "q", tweets: [post(1, { media: [{ type: "video", url: "https://pbs.twimg.com/poster.png" }] })], config: config({ maxSynthesisChars: 5_000, imageInputBounds: {} }), model: MODEL, deps: {
    now, processVideo: async input => { videos++; return { postUrl: input.postUrl, method: "gemini-native", frames: [], notes: [] }; }, complete: async () => "ok",
  } });
  assert.equal(videos, 0);
  assert.ok(details.notes?.some(note => /no video\/STT provider call/.test(note)));
});

for (const [name, char] of [["NUL", "\u0000"], ["lone surrogate", "\ud800"]] as const) {
  test(`JSON-worst ${name} evidence is reserved before any video/STT call`, async () => {
    const target = { ...MODEL, inputLimits: { maxRequestBytes: 25_000 } };
    const budget = new InputBudget([target]);
    let videos = 0, completions = 0;
    const details = await synthesizeAnswer({ query: "q", tweets: [post(1, { media: [{ type: "video", url: "https://pbs.twimg.com/video.png" }] })], config: config({ imageInputBounds: {} }), model: target, deps: {
      inputBudget: budget, now, processVideo: async input => { videos++; return { postUrl: input.postUrl, method: "openai-compatible", transcript: char.repeat(4_000), visualNotes: char.repeat(1_500), frames: [], notes: [] }; },
      complete: async request => { completions++; budget.assert(request); return "ok"; },
    } });
    assert.equal(videos, 0); assert.equal(completions, 1);
    assert.ok(details.notes?.some(note => /no video\/STT provider call/.test(note)));
  });
}

test("JSON-worst manifest reservation can omit images before downloading", async () => {
  const target = { ...MODEL, inputLimits: { maxRequestBytes: 14_000 } };
  const cfg = config({ imageInputBounds: { "test/budget": { ...TEST_IMAGE_BOUNDS, maxImages: 1, maxBytes: 200 } } });
  const budget = new InputBudget([target], cfg.maxSynthesisChars, cfg.imageInputBounds);
  let downloads = 0;
  const details = await synthesizeAnswer({ query: "q", tweets: [post(1, { media: [{ type: "photo", url: "https://pbs.twimg.com/photo.png" }] })], config: cfg, model: target, deps: {
    inputBudget: budget, now, fetchMedia: async () => { downloads++; return TEST_IMAGE; }, complete: async request => { budget.assert(request); assert.equal(request.images.length, 0); return "ok"; },
  } });
  assert.equal(downloads, 0);
  assert.ok(details.notes?.some(note => /no space/.test(note)));
});

test("declared raster, byte and dimension bounds intersect catalogue limits", () => {
  assert.deepEqual(imageDimensions(TEST_IMAGE, 10_000), { width: 1, height: 1 });
  const budget = new InputBudget([{ ...MODEL, inputLimits: { images: { maxPerMessage: 2, resize: { maxWidth: 1, maxHeight: 1, maxBytes: 100 } } } }], 60_000, { "test/budget": TEST_IMAGE_BOUNDS });
  assert.equal(budget.imageBounds!.maxBytes, 75); assert.equal(budget.imageBounds!.maxImages, 2);
  assert.equal(budget.acceptsImage(TEST_IMAGE), true);
  assert.equal(budget.acceptsImage({ data: "AAAA", mimeType: "image/jpeg" }), false);
  assert.equal(budget.acceptsImage({ ...TEST_IMAGE, mimeType: "image/gif" }), false);
  const larger = Buffer.from(TEST_IMAGE.data, "base64"); larger.writeUInt32BE(2, 16);
  assert.equal(budget.acceptsImage({ ...TEST_IMAGE, data: larger.toString("base64") }), false);
  assert.equal(imageDimensions(TEST_IMAGE, 10), undefined);
});

test("shared image slots cap photos plus frames, without dangling references", async () => {
  const details = await synthesizeAnswer({ query: "q", tweets: [post(1, { media: [{ type: "photo", url: "https://pbs.twimg.com/photo.png" }, { type: "video", url: "https://pbs.twimg.com/poster.png" }] })], config: config({ maxFrames: 8, imageInputBounds: { "test/budget": { ...TEST_IMAGE_BOUNDS, maxImages: 3 } } }), model: MODEL, deps: {
    now, fetchMedia: async () => TEST_IMAGE, processVideo: async input => ({ postUrl: input.postUrl, method: "frames+stt", transcript: "speech", frames: Array.from({ length: 8 }, (_, i) => ({ ...TEST_IMAGE, label: `frame ${i}` })), notes: [] }),
    complete: async request => { assert.equal(request.images.length, 3); assert.match(request.prompt, /^image references: 1, 2, 3 /m); assert.ok(!request.prompt.includes("image references: 1, 2, 3, 4")); assert.equal(request.mediaManifest!.split("\n").length, 3); return "ok"; },
  } });
  assert.ok(details.notes?.some(note => /slot\/raster\/dimension/.test(note)));
});

test("an invalid image creates neither a manifest entry nor a reference", async () => {
  const details = await synthesizeAnswer({ query: "q", tweets: [post(1, { media: [{ type: "photo", url: "https://pbs.twimg.com/photo.png" }] })], config: config(), model: MODEL, deps: {
    now, fetchMedia: async () => ({ data: "AAAA", mimeType: "image/jpeg" }), complete: async request => { assert.equal(request.images.length, 0); assert.equal(request.mediaManifest, undefined); assert.ok(!/^image references:/m.test(request.prompt)); return "ok"; },
  } });
  assert.ok(details.notes?.some(note => /raster\/dimension\/byte/.test(note)));
  assert.ok(!details.notes?.some(note => /could not be downloaded/.test(note)), "successful download rejected by admission is not a download failure");
});

test("worst-case bound evidence and manifests are reserved before preprocessing", async () => {
  const small = { ...MODEL, id: "small", contextWindow: 64_000, maxTokens: 2_048, supportsImage: false };
  const cfg = config(), budget = new InputBudget([MODEL, small], cfg.maxSynthesisChars, cfg.imageInputBounds);
  const video = { type: "video", url: "https://pbs.twimg.com/video.png" };
  const roots = [post(1, { media: [video], quoted: post(2, { media: [video] }) })];
  let calls = 0;
  await synthesizeAnswer({ query: "q", tweets: roots, config: cfg, model: MODEL, deps: { inputBudget: budget, now,
    processVideo: async input => { calls++; return { postUrl: input.postUrl, method: "界".repeat(1_000) as "frames+stt", transcript: "界".repeat(100_000), visualNotes: "界".repeat(100_000), frames: Array.from({ length: 30 }, () => ({ ...TEST_IMAGE, label: "界".repeat(100_000) })), notes: [] }; },
    complete: async request => { budget.assert(request); assert.match(request.prompt, /^quoted transcript: /m); assert.equal(request.maxTokens, 2_048); assert.ok(request.images.length < 30); return "ok"; },
  } });
  assert.equal(calls, 1, "one reserved shared asset, not per-binding processing");
});

test("preflight also rejects a question too large for a smaller fallback", () => {
  const registry = fakeRegistry([{ ...TEST_LIMITS, provider: "test", id: "budget", input: ["text"] }, { provider: "test", id: "small", input: ["text"], contextWindow: 8_000, maxTokens: 1_000 }], async () => "unexpected");
  assert.throws(() => resolveSynthesisBackend({ config: config({ synthesisModel: "test/budget" }), env: { TWITTERAPI_IO_API_KEY: "budget-small-question" }, registry, fallbackModelIds: ["test/small"] }, "q".repeat(10_000)), /before retrieval/);
});

test("accounts, trends and documents select complete evidence under the same ceiling", async () => {
  const budget = new InputBudget([MODEL], 3_000), seen: SynthesisRequest[] = [];
  const deps = { inputBudget: budget, now, complete: async (request: SynthesisRequest) => { budget.assert(request); seen.push(request); return "no links"; } };
  const users: UserProfile[] = Array.from({ length: 10 }, (_, i) => ({ handle: `user${i}`, name: "Name", bio: "b".repeat(700), profileUrl: `https://x.com/user${i}` }));
  const accounts = await synthesizeUserAnswer({ query: "q", users, config: config(), model: MODEL, deps });
  const trends = await synthesizeTrends({ query: "q", trends: Array.from({ length: 10 }, (_, i) => ({ name: `Trend${i}`, query: `trend${i}`, metaDescription: "m".repeat(400) })), model: MODEL, deps });
  const doc = await synthesizeDocument({ query: "q", title: "Metadata", body: Array.from({ length: 10 }, (_, i) => `field${i}: ${"v".repeat(600)}`).join("\n"), citations: ["https://x.com/source"], model: MODEL, deps });
  assert.equal(seen.length, 3);
  for (const details of [accounts, trends, doc]) assert.ok(details.notes?.some(note => /locally/.test(note)));
  assert.ok(accounts.citations.length > 0 && accounts.citations.length < users.length);
  assert.ok(trends.citations.length > 0 && trends.citations.length < 10);
  assert.ok(seen[2].prompt.includes("field0: " + "v".repeat(600)));
});

test("physical calls including reasoning repair and fallback use the reserved output", async () => {
  const calls: any[] = [];
  const registry = fakeRegistry([{ ...TEST_LIMITS, provider: "test", id: "budget", input: ["text"] }, { ...TEST_LIMITS, provider: "test", id: "fallback", input: ["text"], maxTokens: 512 }], async (model, context, options) => {
    calls.push({ model, context, options });
    if (calls.length === 1) throw new Error("reasoning_effort 'none' is not supported; supported values: [low, high]");
    if (calls.length === 2) throw new Error("401 unauthorized");
    return { content: [{ type: "text", text: "ok" }] };
  });
  const backend = resolveSynthesisBackend({ config: config({ synthesisModel: "test/budget" }), env: { TWITTERAPI_IO_API_KEY: "budget-physical" }, registry, fallbackModelIds: ["test/fallback"] }, "q");
  const result = await backend.complete({ model: MODEL, system: "s", prompt: "q", images: [] });
  assert.equal(result, "ok"); assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.maxTokens === 512));
  assert.equal(calls[1].options.reasoningEffort, "low");
  await assert.rejects(backend.complete({ model: MODEL, system: "s", prompt: "x".repeat(130_000), images: [] }), /input budget/);
  assert.equal(calls.length, 3, "no physical completion for oversized actual input");
});

test("a reasoning repair rechecks changed input immediately before its physical call", async () => {
  const images = [TEST_IMAGE]; let calls = 0;
  const registry = fakeRegistry([{ ...TEST_LIMITS, provider: "test", id: "budget", input: ["text", "image"] }], async () => {
    calls++; if (calls === 1) { images.push(TEST_IMAGE); throw new Error("reasoning_effort 'none' is not supported; supported values: [low, high]"); }
    return { content: [{ type: "text", text: "unguarded repair" }] };
  });
  const backend = resolveSynthesisBackend({ config: config({ synthesisModel: "test/budget", imageInputBounds: { "test/budget": { ...TEST_IMAGE_BOUNDS, maxImages: 1 } } }), env: { TWITTERAPI_IO_API_KEY: "budget-repair-guard" }, registry }, "q");
  await assert.rejects(backend.complete({ model: MODEL, system: "s", prompt: "q", images }), /input budget/);
  assert.equal(calls, 1);
});

test("unbounded image fallback strips manifests AND all structural image references", async () => {
  const calls: any[] = [];
  const registry = fakeRegistry([{ ...TEST_LIMITS, provider: "test", id: "budget", input: ["text", "image"] }, { ...TEST_LIMITS, provider: "test", id: "fallback", input: ["text", "image"] }], async (model, context) => {
    calls.push({ model, context }); if (model.id === "budget") throw new Error("401 unauthorized"); return { content: [{ type: "text", text: "ok" }] };
  });
  const backend = resolveSynthesisBackend({ config: config({ synthesisModel: "test/budget" }), env: { TWITTERAPI_IO_API_KEY: "budget-fallback" }, registry, fallbackModelIds: ["test/fallback"] }, "q");
  await backend.complete({ model: MODEL, system: "s", prompt: "text: keep\nimage references: 1 (only if images delivered)\nquoted image references: 1 (only if images delivered)\nreposted image references: 1 (only if images delivered)", images: [TEST_IMAGE], mediaManifest: "image label" });
  assert.ok(Array.isArray(calls[0].context.messages[0].content));
  assert.equal(calls[1].context.messages[0].content, "text: keep\n");
  assert.equal(backend.imagesDropped(), true);
  const request = { model: MODEL, system: "s", prompt: "text: image references: 1\nquoted text: image references: 1\nimage references: 1 (only if images delivered)", images: [TEST_IMAGE] };
  assert.match(withoutImages(request).prompt, /quoted text: image references/);
});

test("attachment stripping preserves a trusted multiline question verbatim", async () => {
  const query = "Explain this literal:\nimage references: 1 (only if images delivered)\nThen answer the question.";
  const registry = fakeRegistry([{ ...TEST_LIMITS, provider: "test", id: "budget", input: ["text", "image"] }, { ...TEST_LIMITS, provider: "test", id: "fallback", input: ["text"] }], async (model, context) => {
    if (model.id === "budget") throw new Error("401 unauthorized");
    assert.ok(context.messages[0].content.includes(`Question: ${query}`));
    assert.ok(!/^image references:/m.test(context.messages[0].content.split("Posts (")[1]));
    return { content: [{ type: "text", text: "ok" }] };
  });
  const cfg = config({ synthesisModel: "test/budget" });
  const backend = resolveSynthesisBackend({ config: cfg, env: { TWITTERAPI_IO_API_KEY: "budget-question-preservation" }, registry, fallbackModelIds: ["test/fallback"] }, query);
  await synthesizeAnswer({ query, tweets: [post(1, { media: [{ type: "photo", url: "https://pbs.twimg.com/photo.png" }] })], config: cfg, model: MODEL, deps: { now, complete: backend.complete, inputBudget: backend.budget, fetchMedia: async () => TEST_IMAGE } });
});

test("serialized request-byte bounds account for escaped text, not just raw characters", () => {
  const budget = new InputBudget([{ ...MODEL, inputLimits: { maxRequestBytes: 4_000 } }]);
  assert.equal(budget.fits({ system: "s", prompt: "a".repeat(1_000), images: [] }), true);
  assert.equal(budget.fits({ system: "s", prompt: "\u0000".repeat(1_000), images: [] }), false);
});

test("no-inline Sources is deduplicated and capped at20 in all output modes", async () => {
  const deps = { now, complete: async () => "no inline URLs" };
  const tweets = Array.from({ length: 25 }, (_, i) => post(i + 1));
  const users = Array.from({ length: 25 }, (_, i) => ({ handle: `u${i}`, name: "Name", profileUrl: `https://x.com/u${i}` }));
  const results = [
    await synthesizeAnswer({ query: "q", tweets, config: config(), model: MODEL, deps }),
    await synthesizeUserAnswer({ query: "q", users, config: config(), model: MODEL, deps }),
    await synthesizeTrends({ query: "q", trends: Array.from({ length: 25 }, (_, i) => ({ name: `t${i}`, query: `t${i}` })), model: MODEL, deps }),
    await synthesizeDocument({ query: "q", title: "Metadata", body: "field: value", citations: [...users.map(user => user.profileUrl), users[0].profileUrl], model: MODEL, deps }),
  ];
  for (const result of results) { assert.equal(result.citations.length, 20); assert.equal(new Set(result.citations).size, 20); assert.ok(result.notes?.some(note => /capped at 20/.test(note))); }
});
