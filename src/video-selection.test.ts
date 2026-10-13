import assert from "node:assert/strict";
import test from "node:test";
import { loadTwitterConfig } from "./config.js";
import { EvidenceBudget } from "./evidence.js";
import { InputBudget } from "./input-budget.js";
import { collectMedia, buildCandidatePrompt, synthesizeAnswer, type SynthesisDeps } from "./synthesize.js";
import type { Tweet, TweetMedia } from "./twitterapi.js";

const model = { provider: "test", id: "ranking", supportsImage: false, contextWindow: 1_000_000, maxTokens: 8_192 };
const config = (extra = {}) => loadTwitterConfig({ twitter: { enableVideoUnderstanding: true, enableVideoProcessing: true, maxVideosPerSearch: 1, ...extra } });
const video = (id: number, durationMillis?: number): TweetMedia => ({ type: "video", url: `https://pbs.twimg.com/v${id}.jpg`, videoVariants: [`https://video.twimg.com/v${id}.mp4`], durationMillis });
const post = (id: number, durationMillis?: number, extra: Partial<Tweet> = {}): Tweet => ({ id: String(id), url: `https://x.com/source/status/${id}`, text: `post ${id}`, media: [video(id, durationMillis)], ...extra });
const speech = (input: Parameters<NonNullable<SynthesisDeps["processVideo"]>>[0]) => ({ postUrl: input.postUrl, method: "transcript-only" as const, frames: [], transcript: `speech from ${input.postUrl}`, notes: [] });
async function collected(posts: Tweet[], extra = {}, deps: Partial<SynthesisDeps> = {}) {
  const calls: string[] = [];
  const media = await collectMedia(posts, config(extra), model, { complete: async () => "", processVideo: async input => { calls.push(input.postUrl); return speech(input); }, ...deps });
  return { calls, media };
}

test("duration bands prefer clip-fitting originals over popular long and unknown videos", async () => {
  const long = post(1, 2_400_000, { viewCount: 1_000_000 });
  const unknown = post(2, undefined, { viewCount: 2_000_000 });
  const short = post(3, 60_000, { viewCount: 1 });
  const { calls, media } = await collected([long, unknown, short], { maxVideosPerSearch: 3 });
  assert.deepEqual(calls, [short.url, long.url, unknown.url]);
  assert.match(media.notes.join(" "), /duration.*views.*likes/i);
});

test("duration band uses maxVideoSeconds with an inclusive boundary, not a fixed cutoff", async () => {
  const a = post(1, 20_001, { viewCount: 999 });
  const b = post(2, 20_000, { viewCount: 0 });
  const c = post(3, 30_000, { viewCount: 1 });
  assert.deepEqual((await collected([a, b, c], { maxVideoSeconds: 20, maxVideosPerSearch: 3 })).calls, [b.url, a.url, c.url]);
  assert.deepEqual((await collected([a, b, c], { maxVideoSeconds: 30, maxVideosPerSearch: 3 })).calls, [a.url, c.url, b.url]);
});

test("views then likes rank within a duration band; exact duration does not override engagement", async () => {
  const a = post(1, 1_000, { viewCount: 4, likeCount: 100 });
  const b = post(2, 100_000, { viewCount: 5, likeCount: 0 });
  const c = post(3, 60_000, { viewCount: 5, likeCount: 1 });
  assert.deepEqual((await collected([a, b, c], { maxVideosPerSearch: 3 })).calls, [c.url, b.url, a.url]);
});

test("known zero views outrank missing views, and likes break missing-view ties", async () => {
  const missing = post(1, 1_000, { likeCount: 999 });
  const zero = post(2, 1_000, { viewCount: 0 });
  const unreported = post(3, 1_000);
  assert.deepEqual((await collected([unreported, missing, zero], { maxVideosPerSearch: 3 })).calls, [zero.url, missing.url, unreported.url]);
  const missingLikes = post(4, 1_000, { viewCount: 0 });
  const zeroLikes = post(5, 1_000, { viewCount: 0, likeCount: 0 });
  assert.deepEqual((await collected([missingLikes, zeroLikes])).calls, [zeroLikes.url]);
});

test("nonfinite, negative and fractional counts are missing metadata, not ranking signals", async () => {
  for (const count of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = post(1, 1_000, { viewCount: count, likeCount: count });
    const zero = post(2, 1_000, { viewCount: 0, likeCount: 0 });
    assert.deepEqual((await collected([invalid, zero])).calls, [zero.url]);
    assert.deepEqual((await collected([{ ...invalid, viewCount: 0 }, zero])).calls, [zero.url]);
  }
});

test("unknown, zero, negative and nonfinite durations rank after known long durations", async () => {
  for (const duration of [undefined, 0, -1, NaN, Infinity]) {
    const unknown = post(1, duration, { viewCount: 9_999 });
    const long = post(2, 2_400_000, { viewCount: 0 });
    assert.deepEqual((await collected([unknown, long])).calls, [long.url]);
  }
});

test("stable ties preserve own, quote, repost and root result/media order without mutating inputs", async () => {
  const root = post(1, 90_000, { viewCount: 1, likeCount: 1, quoted: post(2, 1_000, { viewCount: 1, likeCount: 1 }), retweetOf: post(3, 50_000, { viewCount: 1, likeCount: 1 }) });
  const later = post(4, 10_000, { viewCount: 1, likeCount: 1 });
  const roots = Object.freeze([Object.freeze(root), Object.freeze(later)]) as unknown as Tweet[];
  Object.freeze(root.media); Object.freeze(root.quoted!.media); Object.freeze(root.retweetOf!.media);
  assert.deepEqual((await collected(roots, { maxVideosPerSearch: 3 })).calls, [root.url, root.quoted!.url, root.retweetOf!.url]);
  assert.deepEqual((await collected([later, root], { maxVideosPerSearch: 3 })).calls, [later.url, root.url, root.quoted!.url]);
  assert.deepEqual(roots.map(x => x.id), ["1", "4"]);
});

test("quoted and reposted media rank by original counts, not enclosing commentary counts", async () => {
  const a = post(1, undefined, { media: [], viewCount: 1_000_000, quoted: post(11, 1_000, { viewCount: 1 }) });
  const b = post(2, undefined, { media: [], viewCount: 0, retweetOf: post(12, 1_000, { viewCount: 50 }) });
  const { calls, media } = await collected([a, b]);
  assert.deepEqual(calls, [b.retweetOf!.url]);
  const prompt = buildCandidatePrompt("q", [a, b], media.evidence);
  assert.match(prompt, /^reposted transcript: speech from https:\/\/x.com\/source\/status\/12$/m);
  assert.ok(!/^quoted transcript:/m.test(prompt)); assert.ok(prompt.indexOf("[1]") < prompt.indexOf("[2]"));
});

test("mirrored wrapper views cannot inflate the original's ranking after ownership reconciliation", async () => {
  const original = post(11, 1_000, { viewCount: 1 });
  const wrapper = post(1, 1_000, { media: original.media, viewCount: 1_000_000, retweetOf: original });
  const competitor = post(2, 1_000, { viewCount: 10 });
  const { calls, media } = await collected([wrapper, competitor]);
  assert.deepEqual(calls, [competitor.url]); assert.equal(media.evidence!.length, 1);
});

test("a later compatible wrapper envelope excludes earlier mirrored wrapper engagement in either order", async () => {
  for (const identity of [{}, { id: undefined }, { url: undefined }]) {
    const original = post(11, 1_000, { viewCount: 1 });
    const full = post(1, 1_000, { media: original.media, viewCount: 1_000_000, retweetOf: original });
    const partial = { ...full, ...identity, retweetOf: undefined };
    const competitor = post(2, 1_000, { viewCount: 10 });
    for (const wrappers of [[partial, full], [full, partial]]) {
      const { calls } = await collected([competitor, ...wrappers]);
      assert.deepEqual(calls, [competitor.url]);
    }
  }
});

test("a conflicting wrapper permalink cannot suppress a legitimate owner's engagement", async () => {
  const own = post(1, 1_000, { viewCount: 1_000_000 });
  const foreign = { ...own, url: "https://x.com/foreign/status/1", viewCount: 0, quoted: post(11, 1_000, { media: own.media, viewCount: 1 }) };
  const competitor = post(2, 1_000, { viewCount: 10 });
  assert.deepEqual((await collected([competitor, own, foreign])).calls, [own.url]);
});

test("deduplicated originals use maximum reported original counts without consuming duplicate slots", async () => {
  const original = post(11, 1_000, { viewCount: 1, likeCount: 0 });
  const a = post(1, undefined, { media: [], quoted: original });
  const competitor = post(2, 1_000, { viewCount: 10 });
  const b = post(3, undefined, { media: [], retweetOf: { ...original, viewCount: 100 } });
  for (const [firstViews, laterViews] of [[1, 100], [100, 1]]) {
    a.quoted!.viewCount = firstViews; b.retweetOf!.viewCount = laterViews;
    const { calls, media } = await collected([competitor, a, b]);
    assert.deepEqual(calls, [original.url]); assert.equal(media.evidence!.length, 2);
    assert.match(media.notes.join(" "), /repeated media/);
    const prompt = buildCandidatePrompt("q", [b, competitor, a], media.evidence);
    assert.equal(prompt.match(/^quoted transcript:/gm)?.length, 1); assert.equal(prompt.match(/^reposted transcript:/gm)?.length, 1);
  }
});

test("late known-ID bridge ranks the coalesced asset and preserves earliest download locator", async () => {
  const exact = video(11, 1_000), known = { ...exact, id: "900", videoVariants: [exact.videoVariants![0] + "?tag=12"] };
  const bridge = { ...exact, id: "900" };
  const sources = [post(11, 1_000, { media: [exact], viewCount: 1 }), post(11, 1_000, { media: [known], viewCount: 2 }), post(11, 1_000, { media: [bridge], viewCount: 100 })];
  const roots = sources.map((source, i) => post(i + 1, undefined, { media: [], quoted: source }));
  const competitor = post(4, 1_000, { viewCount: 10 });
  const urls: string[] = [];
  const { media } = await collected([competitor, ...roots], {}, { processVideo: async input => { urls.push(input.media.videoVariants![0]); return speech(input); } });
  assert.deepEqual(urls, exact.videoVariants); assert.equal(media.evidence!.length, 3);
});

test("global complete-input reservation and dispatch both select a later high-ranked source", async () => {
  for (const output of ["answer", "posts"] as const) {
    const long = post(1, 2_400_000, { viewCount: 1 });
    const short = post(2, 5_000, { viewCount: 99 });
    const calls: string[] = []; let seen = "";
    const details = await synthesizeAnswer({ query: "q", tweets: [long, short], model, config: config(), deps: { output,
      complete: async request => { seen = request.prompt; return "ok"; }, processVideo: async input => { calls.push(input.postUrl); return speech(input); },
    } });
    assert.deepEqual(calls, [short.url], output);
    const prompt = output === "posts" ? details.text : seen;
    assert.ok(prompt.indexOf(long.url!) < prompt.indexOf(short.url!));
    assert.match(prompt, /speech from https:\/\/x.com\/source\/status\/2/);
    assert.match(details.notes!.join(" "), /video.*cap.*1/i);
    assert.ok(!/Complete-input budget did not reserve preprocessing/.test(details.notes!.join(" ")), "cap skips are not input-fit failures");
  }
});

test("an input-budget-rejected high-fanout asset allows the next ranked asset to use the slot", async () => {
  const original = post(11, 1_000, { viewCount: 100 });
  const wrappers = Array.from({ length: 5 }, (_, i) => post(i + 1, undefined, { media: [], quoted: original }));
  const low = post(99, 1_000, { viewCount: 1 });
  const calls: string[] = [];
  const details = await synthesizeAnswer({ query: "q", tweets: [...wrappers, low], model, config: config({ maxSynthesisChars: 28_000 }), deps: {
    output: "posts", inputBudget: new EvidenceBudget(28_000), complete: async () => { throw new Error("no synthesis"); },
    processVideo: async input => { calls.push(input.postUrl); return speech(input); },
  } });
  assert.deepEqual(calls, [low.url]);
  assert.match(details.notes!.join(" "), /Complete-input budget did not reserve preprocessing for 1 video asset/);
  assert.ok(!/video\(s\) skipped processing: per-search video cap/.test(details.notes!.join(" ")));
  assert.match(details.text, /Posts \(6\)/);
});

test("ranking never pulls an omitted high-engagement bundle back into media processing", async () => {
  const oversized = post(1, 1_000, { text: "x".repeat(70_000), viewCount: 1_000_000 });
  const kept = post(2, 1_000, { viewCount: 0 });
  const calls: string[] = [];
  const details = await synthesizeAnswer({ query: "q", tweets: [oversized, kept], model, config: config(), deps: {
    output: "posts", complete: async () => "", processVideo: async input => { calls.push(input.postUrl); return speech(input); },
  } });
  assert.deepEqual(calls, [kept.url]); assert.ok(!details.text.includes(oversized.url!));
  assert.match(details.notes!.join(" "), /omitted 1 retrieved post bundle/);
});

test("ranked videos preserve shared deadlines and disclose deadline skips rather than relevance", async () => {
  const a = post(1, 1_000, { viewCount: 1 }); const b = post(2, 1_000, { viewCount: 10 });
  let clock = 0; const calls: string[] = []; const deadlines: number[] = [];
  const { media } = await collected([a, b], { maxVideosPerSearch: 2, videoBudgetMs: 10 }, { now: () => clock, processVideo: async input => {
    calls.push(input.postUrl); deadlines.push(input.deadline); clock = 11; return speech(input);
  } });
  assert.deepEqual(calls, [b.url]); assert.deepEqual(deadlines, [10]);
  assert.match(media.notes.join(" "), /shared video deadline exhausted/);
  assert.ok(!/most relevant|less relevant/i.test(media.notes.join(" ")));
});

test("ranking does not change photo-first collection or poster-only source order", async () => {
  const a = post(1, 2_400_000, { viewCount: 1, media: [{ type: "photo", url: "https://pbs.twimg.com/photo.jpg" }, video(1, 2_400_000)] });
  const b = post(2, 1_000, { viewCount: 10 });
  const events: string[] = [];
  await collectMedia([a, b], config({ enableImageUnderstanding: true }), { ...model, supportsImage: true }, {
    complete: async () => "", fetchMedia: async url => { events.push(url); return { data: "image", mimeType: "image/jpeg" }; },
    processVideo: async input => { events.push(input.postUrl); return speech(input); },
  });
  assert.equal(events[0], a.media![0].url); assert.equal(events[1], b.url);
  const posters: string[] = [];
  await collectMedia([a, b], config({ enableVideoProcessing: false }), { ...model, supportsImage: true }, {
    complete: async () => "", fetchMedia: async url => { posters.push(url); return { data: "image", mimeType: "image/jpeg" }; },
  });
  assert.deepEqual(posters, [a.media![1].url, b.media![0].url]);
});

test("cancelled ranked processing stops later videos and never bills poster fallback", async () => {
  const controller = new AbortController(); let attempts = 0, posters = 0;
  const a = post(1, 1_000, { viewCount: 1 }), b = post(2, 1_000, { viewCount: 10 });
  await assert.rejects(collected([a, b], { maxVideosPerSearch: 2 }, {
    signal: controller.signal, fetchMedia: async () => { posters++; return undefined; }, processVideo: async input => {
      attempts++; assert.equal(input.postUrl, b.url); controller.abort(); throw controller.signal.reason;
    },
  }), { name: "AbortError" });
  assert.equal(attempts, 1); assert.equal(posters, 0);
});

test("global ranking preserves quoted and reposted attribution without reordering source bundles", async () => {
  const a = post(1, 2_400_000, { viewCount: 1_000_000, quoted: post(11, 10_000, { viewCount: 1 }) });
  const b = post(2, undefined, { media: [], viewCount: 0, retweetOf: post(12, 5_000, { viewCount: 50 }) });
  const calls: string[] = [];
  const details = await synthesizeAnswer({ query: "q", tweets: [a, b], model, config: config({ maxVideosPerSearch: 2 }), deps: {
    output: "posts", complete: async () => { throw new Error("no synthesis"); }, processVideo: async input => { calls.push(input.postUrl); return speech(input); },
  } });
  assert.deepEqual(calls, [b.retweetOf!.url, a.quoted!.url]);
  assert.match(details.text, /^quoted transcript: speech from https:\/\/x.com\/source\/status\/11$/m);
  assert.match(details.text, /^reposted transcript: speech from https:\/\/x.com\/source\/status\/12$/m);
  assert.ok(!/^transcript:/m.test(details.text)); assert.ok(details.text.indexOf(a.url!) < details.text.indexOf(b.url!));
  assert.equal(details.synthesisCalls, 0);
});

test("a failed selected analysis still consumes its bounded processing slot", async () => {
  const a = post(1, 1_000, { viewCount: 1 }), b = post(2, 1_000, { viewCount: 10 });
  const calls: string[] = [];
  const { media } = await collected([a, b], {}, { processVideo: async input => { calls.push(input.postUrl); throw new Error("native/STT failed"); } });
  assert.deepEqual(calls, [b.url]); assert.match(media.notes.join(" "), /Video processing failed/);
  assert.match(media.notes.join(" "), /per-search video cap is 1/);
});

test("preprocessing reservations never exceed the configured video cap", async () => {
  class CappedBudget extends InputBudget {
    override fits(...args: Parameters<InputBudget["fits"]>): boolean {
      assert.ok((args[0].prompt.match(/^video evidence \(/gm)?.length ?? 0) <= 1, "reservation exceeded the one-video cap");
      return super.fits(...args);
    }
  }
  const budget = new CappedBudget([model]);
  const calls: string[] = [];
  await synthesizeAnswer({ query: "q", tweets: [post(1, 1_000), post(2, 1_000), post(3, 1_000)], model, config: config(), deps: {
    inputBudget: budget, complete: async request => { budget.assert(request); return "ok"; },
    processVideo: async input => { calls.push(input.postUrl); return speech(input); },
  } });
  assert.deepEqual(calls, ["https://x.com/source/status/1"]);
});

test("ranked reservation still honours the smallest fallback and JSON worst-case bounds", async () => {
  const constrained = { ...model, id: "bytes", inputLimits: { maxRequestBytes: 25_000 } };
  const budget = new InputBudget([model, constrained]); let calls = 0;
  const details = await synthesizeAnswer({ query: "q", tweets: [post(1, 2_400_000, { viewCount: 1 }), post(2, 1_000, { viewCount: 100 })],
    config: config(), model, deps: { inputBudget: budget, complete: async request => { budget.assert(request); return "ok"; },
      processVideo: async input => { calls++; return { ...speech(input), transcript: "\u0000".repeat(4_000) }; },
    },
  });
  assert.equal(calls, 0); assert.match(details.notes!.join(" "), /no video\/STT provider call/);
});
