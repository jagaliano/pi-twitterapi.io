import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { fetchUserProfile, searchTweets, searchUsers, normalizeParams, type FetchLike } from "./twitterapi.js";
import { requestWithRetry } from "./twitterapi/http.js";

const API = "https://api.twitterapi.io";
const key = () => `pacer-fixture-${randomUUID()}`;
const response = () => Response.json({ tweets: [{ id: "1", text: "Post" }], users: [{ userName: "example" }], data: { userName: "example" }, has_next_page: false });
function clock(ignoreAbort = false) {
  let t = 0;
  const pending: { at: number; finish: () => void }[] = [];
  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const cleanup = () => { const index = pending.indexOf(waiter); if (index >= 0) pending.splice(index, 1); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error("aborted")); };
    const waiter = { at: t + ms, finish: () => { cleanup(); resolve(); } };
    pending.push(waiter);
    if (!ignoreAbort) { if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true }); }
  });
  return { now: () => t, sleep, pending, advanceSync: (ms: number) => { t += ms; }, advance: async (ms: number) => { t += ms; for (const waiter of [...pending]) if (waiter.at <= t) waiter.finish(); await tick(); } };
}
function options(c: ReturnType<typeof clock>, interval = 20) {
  return { now: c.now, sleep: c.sleep, minRequestIntervalMs: interval, maxRetries: 0, retryBaseDelayMs: 0, timeoutMs: 30_000 };
}

test("concurrent mixed endpoints share first-attempt spacing across separate fetchers", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  const fetcher = (): FetchLike => async () => { at.push(c.now()); return response(); };
  const all = Promise.all([
    searchTweets(normalizeParams({ query: "Q", count: 1 }), credential, fetcher(), options(c)),
    searchUsers("Q", credential, fetcher(), options(c)),
    fetchUserProfile("example", credential, fetcher(), options(c)),
  ]);
  await tick(); assert.deepEqual(at, [0]);
  await c.advance(20); assert.deepEqual(at, [0, 20]);
  await c.advance(20); await all; assert.deepEqual(at, [0, 20, 40]);
});

test("different credentials do not share a dispatch queue", async () => {
  const c = clock(), at: number[] = [];
  const fetcher: FetchLike = async () => { at.push(c.now()); return response(); };
  await Promise.all([fetchUserProfile("example", key(), fetcher, options(c)), fetchUserProfile("example", key(), fetcher, options(c))]);
  assert.deepEqual(at, [0, 0]); assert.equal(c.pending.length, 0);
});

test("429, 503 and transport retries re-enter the same attempt queue", async () => {
  for (const status of [429, 503, "transport"] as const) {
    const c = clock(), credential = key(), at: number[] = [];
    let calls = 0;
    const retrying: FetchLike = async () => { at.push(c.now()); if (++calls === 1) { if (status === "transport") throw new Error("socket closed"); return Response.json({}, { status }); } return response(); };
    const all = Promise.all([
      searchTweets(normalizeParams({ query: "Q", count: 1 }), credential, retrying, { ...options(c), maxRetries: 1 }),
      fetchUserProfile("example", credential, async () => { at.push(c.now()); return response(); }, options(c)),
    ]);
    await tick(); assert.deepEqual(at, [0]);
    await c.advance(20); await c.advance(20); await all;
    assert.deepEqual(at, [0, 20, 40], String(status)); assert.equal(calls, 2);
  }
});

test("Retry-After is not shortened and backoff does not monopolize the dispatch lock", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  let calls = 0;
  const retry = requestWithRetry(`${API}/twitter/tweets`, credential, async () => { at.push(c.now()); return ++calls === 1 ? Response.json({}, { status: 429, headers: { "Retry-After": "1" } }) : response(); }, { ...options(c), maxRetries: 1 });
  const peer = fetchUserProfile("example", credential, async () => { at.push(c.now()); return response(); }, options(c));
  await tick(); await c.advance(20); await peer; assert.deepEqual(at, [0, 20]);
  await c.advance(979); assert.deepEqual(at, [0, 20]);
  await c.advance(1); await retry; assert.deepEqual(at, [0, 20, 1000]);
});

test("early and late timer wakeups re-check actual dispatch spacing", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  const fetcher: FetchLike = async () => { at.push(c.now()); return response(); };
  const all = Promise.all(Array.from({ length: 3 }, () => fetchUserProfile("example", credential, fetcher, options(c))));
  await tick(); await c.advance(100); assert.deepEqual(at, [0, 100]);
  await c.advance(19); assert.deepEqual(at, [0, 100]);
  await c.advance(1); await all; assert.deepEqual(at, [0, 100, 120]);

  // Post-invocation timestamps independently protect late wakes. Force an
  // EARLY wake too, so removing the loop recheck must still fail this test.
  const early = clock(), earlyKey = key(), earlyAt: number[] = [];
  const earlyCalls = Promise.all(Array.from({ length: 2 }, () => fetchUserProfile("example", earlyKey, async () => { earlyAt.push(early.now()); return response(); }, options(early))));
  await tick(); assert.equal(early.pending.length, 1);
  early.advanceSync(10); early.pending[0].finish();
  await tick(); assert.deepEqual(earlyAt, [0], "an early wake must wait for the remaining gap");
  await early.advance(10); await earlyCalls; assert.deepEqual(earlyAt, [0, 20]);
});

test("dispatch setup overhead cannot shorten the physical fetch-to-fetch gap", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  let firstSample = true;
  const now = () => { const at = c.now(); if (firstSample) { firstSample = false; c.advanceSync(1); } return at; };
  const fetcher: FetchLike = async () => { at.push(c.now()); return response(); };
  const all = Promise.all(Array.from({ length: 2 }, () => fetchUserProfile("example", credential, fetcher, { ...options(c), now })));
  await tick(); assert.deepEqual(at, [1]);
  await c.advance(19); assert.deepEqual(at, [1], "pre-dispatch setup must not be credited toward the next gap");
  await c.advance(1); await all; assert.deepEqual(at, [1, 21]);
});

test("simultaneous callers with different intervals use the larger active requirement", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  const fetcher: FetchLike = async () => { at.push(c.now()); return response(); };
  const all = Promise.all([fetchUserProfile("example", credential, fetcher, options(c, 5)), fetchUserProfile("example", credential, fetcher, options(c, 30))]);
  await tick(); assert.deepEqual(at, [0]);
  await c.advance(29); assert.deepEqual(at, [0]);
  await c.advance(1); await all; assert.deepEqual(at, [0, 30]);
});

test("largest live interval applies through body I/O, then previous interval protects the next dispatch", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  let finish!: (value: { data: { userName: string } }) => void;
  const high = fetchUserProfile("example", credential, async () => {
    at.push(c.now());
    const result = response();
    result.json = () => new Promise<{ data: { userName: string } }>(resolve => { finish = resolve; });
    return result;
  }, options(c, 30));
  const low = () => fetchUserProfile("example", credential, async () => { at.push(c.now()); return response(); }, options(c, 5));
  try {
    const peers = [low(), low()];
    await tick(); await c.advance(30);
    assert.deepEqual(at, [0, 30], "response body reads must not hold the dispatch lock");
    await peers[0]; await c.advance(30); await peers[1];
    assert.deepEqual(at, [0, 30, 60], "the body reader's interval remains active");
    finish({ data: { userName: "example" } }); await high;
    const next = low(); await tick(); await c.advance(29); assert.equal(at.length, 3);
    await c.advance(1); await next;
    let completed = false;
    const reduced = low().then(() => { completed = true; });
    await tick(); await c.advance(5);
    assert.equal(completed, true, "a retired higher interval must not perpetuate itself");
    await reduced;
    assert.deepEqual(at, [0, 30, 60, 90, 95], "higher interval can expire after its protected gap");
  } finally {
    finish?.({ data: { userName: "example" } });
    await high.catch(() => {});
  }
});

test("caller cancellation interrupts an injected pacing sleep that ignores its signal", async () => {
  const c = clock(true), credential = key(), at: number[] = [];
  const fetcher: FetchLike = async () => { at.push(c.now()); return response(); };
  await fetchUserProfile("example", credential, fetcher, options(c));
  const controller = new AbortController();
  const cancelled = fetchUserProfile("example", credential, fetcher, { ...options(c, 60), signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(cancelled, /cancelled/);
  let completed = false;
  const next = fetchUserProfile("example", credential, fetcher, options(c)).then(() => { completed = true; });
  await tick(); await c.advance(20);
  assert.equal(completed, true, "cancelled 60ms sleep must release the queue for the remaining 20ms requirement");
  await next; assert.deepEqual(at, [0, 20]);
});

test("queued cancellation is immediate and neither consumes a slot nor poisons later jobs", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  const fetcher: FetchLike = async () => { at.push(c.now()); return response(); };
  await fetchUserProfile("example", credential, fetcher, options(c));
  const waiting = fetchUserProfile("example", credential, fetcher, options(c));
  const controller = new AbortController();
  const cancelled = fetchUserProfile("example", credential, fetcher, { ...options(c), signal: controller.signal });
  await tick(); controller.abort();
  const rejected = assert.rejects(cancelled, /cancelled/);
  assert.equal(await Promise.race([rejected.then(() => true), tick().then(() => false)]), true, "queued cancellation must not wait for its predecessor");
  const next = fetchUserProfile("example", credential, fetcher, options(c));
  await c.advance(20); await waiting; await c.advance(20); await next;
  assert.deepEqual(at, [0, 20, 40]);
});

test("cancellation also interrupts Retry-After sleep without dispatching another attempt", async () => {
  const c = clock(true), credential = key(), controller = new AbortController();
  let calls = 0;
  const request = requestWithRetry(`${API}/twitter/tweets`, credential, async () => { calls++; return Response.json({}, { status: 429, headers: { "Retry-After": "1" } }); }, { ...options(c), maxRetries: 1, signal: controller.signal });
  await tick(); controller.abort();
  const rejected = assert.rejects(request, /cancelled/);
  assert.equal(await Promise.race([rejected.then(() => true), tick().then(() => false)]), true, "backoff cancellation must not wait for its timer");
  assert.equal(calls, 1);
  const peer = fetchUserProfile("example", credential, async () => { calls++; return response(); }, options(c));
  await tick(); await c.advance(20); await peer;
  assert.equal(calls, 2, "cancelled backoff does not retain the active request or spend another attempt");
});

test("already-cancelled calls never dispatch or delay another caller", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  const fetcher: FetchLike = async () => { at.push(c.now()); return response(); };
  await assert.rejects(fetchUserProfile("example", credential, fetcher, { ...options(c), signal: AbortSignal.abort() }), /cancelled/);
  await fetchUserProfile("example", credential, fetcher, options(c)); assert.deepEqual(at, [0]);
});

test("zero interval cannot bypass another caller's active or previous interval", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  const fetcher: FetchLike = async () => { at.push(c.now()); return response(); };
  await fetchUserProfile("example", credential, fetcher, options(c, 20));
  const zero = fetchUserProfile("example", credential, fetcher, options(c, 0));
  await tick(); await c.advance(19); assert.deepEqual(at, [0]);
  await c.advance(1); await zero; assert.deepEqual(at, [0, 20]);
});

test("unrelated media and provider hosts do not enter Twitter's credential queue", async () => {
  const c = clock(), credential = key(), at: number[] = [];
  const fetcher: FetchLike = async () => { at.push(c.now()); return response(); };
  await fetchUserProfile("example", credential, fetcher, options(c));
  const foreign = Promise.all([
    requestWithRetry("https://pbs.twimg.com/image.jpg", credential, fetcher, options(c)),
    requestWithRetry("https://provider.example/chat/completions", credential, fetcher, options(c)),
  ]);
  await tick(); assert.equal(c.pending.length, 0, "unrelated hosts must not queue a pacing sleep");
  await foreign; assert.deepEqual(at, [0, 0, 0]);
});

test("idle credential state expires after cooldown instead of retaining its test clock", async () => {
  const c = clock(), credential = key();
  await fetchUserProfile("example", credential, async () => response(), options(c));
  await c.advance(20); await delay(25); // ref'd wait lets the unref'd cleanup timer run
  const freshClock = clock();
  let completed = false;
  const fresh = fetchUserProfile("example", credential, async () => response(), options(freshClock)).then(() => { completed = true; });
  await tick(); assert.equal(completed, true, "an expired credential must start fresh, with no old clock state");
  await fresh;
});

test("non-finite direct pacing options fail before dispatch", async () => {
  for (const interval of [NaN, Infinity]) {
    await assert.rejects(fetchUserProfile("example", key(), async () => { assert.fail("invalid interval dispatched"); }, { minRequestIntervalMs: interval, maxRetries: 0 }), /must be finite/);
  }
});
