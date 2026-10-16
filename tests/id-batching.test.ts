import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchTweetsByIds, CancelledError, RedirectError, type FetchLike } from "../src/twitterapi.js";
import { runTwitterApiTweetsByIds } from "../src/backend.js";
import { loadTwitterConfig } from "../src/config.js";
import { RunTelemetry } from "../src/telemetry.js";
import { TEST_LIMITS, TEST_IMAGE, TEST_IMAGE_BOUNDS } from "./fixtures/budget.js";

const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
const raw = (id: string) => ({ id, url: `https://x.com/fixture/status/${id}`, text: `Source ${id}` });
const response = (tweets: unknown[], status = 200) => Response.json({ tweets }, { status });
const sentIds = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : String(input)).searchParams.get("tweet_ids")!.split(",");
const options = { minRequestIntervalMs: 0, maxRetries: 0 };
let serial = 0;
const key = () => `r1-batching-fixture-${++serial}`;
const config = (settings = {}) => loadTwitterConfig({ twitter: { minRequestIntervalMs: 0, retryBaseDelayMs: 0, ...settings } });
const model = { provider: "fixture", id: "answer", input: [], ...TEST_LIMITS };

for (const n of [1, 50, 51, 100]) {
  test(`${n} unique IDs keep the public limit but dispatch at most 50 per request`, async () => {
    const sent: string[][] = [];
    const result = await fetchTweetsByIds(ids(n), key(), async (input, init) => {
      assert.equal(init?.redirect, "manual");
      const batch = sentIds(input);
      sent.push(batch);
      assert.ok(batch.length <= 50, "upstream request size cannot exceed 50");
      return response(batch.map(raw));
    }, options);
    assert.deepEqual(sent, n <= 50 ? [ids(n)] : [ids(50), ids(n).slice(50)]);
    assert.equal(result.pagesFetched, Math.ceil(n / 50));
    assert.equal(result.tweets.length, n);
    assert.equal(result.stoppedBy, "exhausted");
    assert.equal(result.truncated, false);
  });
}

for (const n of [0, 101]) {
  test(`${n} unique IDs are rejected before any fetch`, async () => {
    let calls = 0;
    await assert.rejects(fetchTweetsByIds(ids(n), key(), async () => { calls++; return response([]); }, options),
      n === 0 ? /at least one id/ : /at most 100/);
    assert.equal(calls, 0);
  });
}

test("canonicalize and deduplicate every input before chunking or billing", async () => {
  const sent: string[][] = [];
  const input = [...ids(50), ...Array.from({ length: 80 }, () => "https://x.com/fixture/status/1"), "https://twitter.com/fixture/status/51"];
  const result = await fetchTweetsByIds(input, key(), async url => {
    const batch = sentIds(url); sent.push(batch); return response(batch.map(raw));
  }, options);
  assert.deepEqual(sent, [ids(50), ["51"]]);
  assert.equal(result.tweets.length, 51);
});

test("a bad reference after the first 50 is rejected before the first paid request", async () => {
  let calls = 0;
  await assert.rejects(fetchTweetsByIds([...ids(50), "not-a-post"], key(), async () => { calls++; return response([]); }, options), /numeric post ids/);
  assert.equal(calls, 0);
});

for (const budget of [{ maxPages: 1 }, { maxPages: 5, maxPagesCeiling: 1 }]) {
  test(`insufficient logical request budget fails before any fetch: ${JSON.stringify(budget)}`, async () => {
    let calls = 0;
    await assert.rejects(fetchTweetsByIds(ids(51), key(), async () => { calls++; return response([]); }, { ...options, ...budget }), /needs 2.*budget.*1/);
    assert.equal(calls, 0);
  });
}

for (const value of [0, -1, 1.5, Infinity, NaN, 101]) {
  test(`invalid maxPages ${value} fails before any fetch`, async () => {
    let calls = 0;
    await assert.rejects(fetchTweetsByIds(["1"], key(), async () => { calls++; return response([]); }, { ...options, maxPages: value }), /maxPages/);
    assert.equal(calls, 0);
  });
}

test("single-chunk lookup still fits a one-request budget", async () => {
  const result = await fetchTweetsByIds(ids(50), key(), async url => response(sentIds(url).map(raw)), { ...options, maxPages: 1, maxPagesCeiling: 1 });
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.tweets.length, 50);
});

test("chunks are sequential and preserve response order rather than inventing input order", async () => {
  let active = false, calls = 0;
  const result = await fetchTweetsByIds(ids(52), key(), async () => {
    assert.equal(active, false, "lookups must not overlap"); active = true;
    await new Promise<void>(resolve => setImmediate(resolve));
    const rows = ++calls === 1 ? [raw("2"), raw("1")] : [raw("52"), raw("51")];
    const r = response(rows);
    const json = r.json.bind(r);
    r.json = async () => { const body = await json(); active = false; return body; };
    return r;
  }, options);
  assert.deepEqual(result.tweets.map(t => t.id), ["2", "1", "52", "51"]);
  assert.equal(calls, 2);
});

test("duplicate IDs and permalink aliases are deduplicated across chunk boundaries", async () => {
  let calls = 0;
  const result = await fetchTweetsByIds(ids(51), key(), async () => response(++calls === 1
    ? [raw("1"), raw("2")]
    : [raw("1"), { ...raw("2"), id: undefined }, raw("51")]), options);
  assert.deepEqual(result.tweets.map(t => t.id), ["1", "2", "51"]);
});

test("an empty successful chunk does not suppress the next explicit-ID chunk", async () => {
  let calls = 0;
  const result = await fetchTweetsByIds(ids(51), key(), async () => response(++calls === 1 ? [] : [raw("51")]), options);
  assert.equal(calls, 2);
  assert.deepEqual(result.tweets.map(t => t.id), ["51"]);
  assert.equal(result.pagesFetched, 2);
});

test("each chunk uses the existing shared pacing boundary", async () => {
  let now = 0;
  const at: number[] = [];
  await fetchTweetsByIds(ids(51), key(), async input => { at.push(now); return response(sentIds(input).map(raw)); }, {
    ...options, minRequestIntervalMs: 25, now: () => now, sleep: async ms => { now += ms; },
  });
  assert.deepEqual(at, [0, 25]);
});

test("only the failed chunk retries; telemetry distinguishes attempts from accepted chunks", async () => {
  const sent: string[][] = [], at: number[] = [];
  const telemetry = new RunTelemetry();
  let now = 0;
  const result = await fetchTweetsByIds(ids(51), key(), telemetry.fetcher(async input => {
    const batch = sentIds(input); sent.push(batch); at.push(now);
    if (sent.length === 2) return Response.json({}, { status: 503, headers: { "Retry-After": "1" } });
    return response(batch.map(raw));
  }, "upstream"), { ...options, maxRetries: 1, minRequestIntervalMs: 25, retryBaseDelayMs: 1, now: () => now,
    sleep: async ms => { now += ms; }, telemetry });
  assert.deepEqual(sent.map(b => b.length), [50, 1, 1]);
  assert.deepEqual(at, [0, 25, 1025]);
  assert.equal(result.pagesFetched, 2);
  const usage = telemetry.snapshot().usage;
  assert.equal(usage.upstreamAttempts, 3); assert.equal(usage.upstreamHttpFailures, 1);
  assert.equal(usage.successfulPages, 2); assert.equal(usage.postsReturned, 51);
});

for (const failure of ["http", "semantic", "malformed", "body"] as const) {
  test(`later ${failure} failure rejects the whole lookup; no fabricated partial success`, async () => {
    let calls = 0;
    await assert.rejects(fetchTweetsByIds(ids(100), key(), async input => {
      const batch = sentIds(input);
      if (++calls === 1) return response(batch.map(raw));
      if (failure === "http") return Response.json({ detail: "fixture forbidden" }, { status: 403 });
      if (failure === "semantic") return Response.json({ status: "error", message: "fixture rejected", tweets: [] });
      if (failure === "malformed") return Response.json({ status: "success" });
      const r = response([]); r.json = async () => { throw new Error("fixture unreadable body"); }; return r;
    }, { ...options, maxRetries: 2, sleep: async () => {} }), /twitterapi\.io/);
    assert.equal(calls, 2, "a billed body/semantic/permanent failure must not replay either chunk");
  });
}

test("redirect refusal on a later chunk keeps its exported error class", async () => {
  let calls = 0;
  await assert.rejects(fetchTweetsByIds(ids(51), key(), async input => ++calls === 1
    ? response(sentIds(input).map(raw)) : new Response(null, { status: 302, headers: { location: "https://example.invalid/" } }), options), RedirectError);
  assert.equal(calls, 2);
});

test("already-cancelled lookup makes no requests", async () => {
  const c = new AbortController(); c.abort(); let calls = 0;
  await assert.rejects(fetchTweetsByIds(ids(51), key(), async () => { calls++; return response([]); }, { ...options, signal: c.signal }), CancelledError);
  assert.equal(calls, 0);
});

for (const n of [1, 51]) {
  test(`cancellation while parsing ${n === 1 ? "final" : "first"} chunk is never returned as success`, async () => {
    const c = new AbortController(); let calls = 0;
    await assert.rejects(fetchTweetsByIds(ids(n), key(), async () => {
      calls++;
      const row = { ...raw("1"), get text() { c.abort(); return "cancel while mapping"; } };
      const r = response([]); r.json = async () => ({ tweets: [row] }); return r;
    }, { ...options, signal: c.signal }), CancelledError);
    assert.equal(calls, 1);
  });
}

test("cancelling a later in-flight chunk rejects without retrying or returning earlier posts", async () => {
  const c = new AbortController(); let calls = 0;
  await assert.rejects(fetchTweetsByIds(ids(51), key(), async input => {
    if (++calls === 1) return response(sentIds(input).map(raw));
    queueMicrotask(() => c.abort());
    return new Promise<Response>(() => {});
  }, { ...options, maxRetries: 2, signal: c.signal }), CancelledError);
  assert.equal(calls, 2);
});

test("multi-chunk progress is reported in order without changing the single-chunk label", async () => {
  const phases: string[] = [];
  await fetchTweetsByIds(ids(51), key(), async input => response(sentIds(input).map(raw)), { ...options, progress: text => { phases.push(text); } });
  assert.deepEqual(phases, ["lookup 1/2 · 0 posts", "lookup 2/2 · 50 posts"]);
  phases.length = 0;
  await fetchTweetsByIds(["1"], key(), async () => response([raw("1")]), { ...options, progress: text => { phases.push(text); } });
  assert.deepEqual(phases, ["reading X"]);
});

test("runner forwards both configured logical budget bounds before any request", async () => {
  for (const settings of [{ maxPages: 1 }, { maxPages: 5, maxPagesCeiling: 1 }]) {
    let calls = 0;
    await assert.rejects(runTwitterApiTweetsByIds({ query: "q", ids: ids(51), output: "posts", config: config(settings),
      env: { TWITTERAPI_IO_API_KEY: key() }, fetcher: async () => { calls++; return response([]); } }), /needs 2.*budget.*1/);
    assert.equal(calls, 0);
  }
});

test("missing-ID notes use IDs, including a returned URL-only alias, after all chunks succeed", async () => {
  let calls = 0;
  const result = await runTwitterApiTweetsByIds({ query: "q", ids: ids(51), output: "posts", config: config(),
    env: { TWITTERAPI_IO_API_KEY: key() }, fetcher: async () => response(++calls === 1
      ? [raw("2"), { ...raw("1"), id: undefined }, raw("3")]
      : [raw("51")]) });
  assert.equal(calls, 2);
  assert.match(result.markdown, /47 requested post id\(s\) were not returned by the upstream: 4, 5, 6/);
  assert.doesNotMatch(result.markdown, /upstream: 1,/);
  assert.equal(result.details.usage!.upstreamAttempts, 2);
  assert.equal(result.details.usage!.successfulPages, 2);
});

test("a later lookup failure never starts synthesis/media or emits missing-ID notes", async () => {
  let calls = 0, completions = 0, media = 0;
  const imageModel = { ...model, input: ["image"] };
  const registry = { getAll: () => [imageModel], find: () => imageModel, complete: async () => {
    completions++; return { stopReason: "stop", content: [{ type: "text", text: "Source https://x.com/fixture/status/1" }] };
  } };
  await assert.rejects(runTwitterApiTweetsByIds({ query: "q", ids: ids(51), config: config({ synthesisModel: "fixture/answer",
    enableImageUnderstanding: true, imageInputBounds: { "fixture/answer": TEST_IMAGE_BOUNDS } }),
    registry, env: { TWITTERAPI_IO_API_KEY: key() }, fetcher: async input => {
      if (!String(input).startsWith("https://api.twitterapi.io/")) {
        media++; return new Response(Buffer.from(TEST_IMAGE.data, "base64"), { headers: { "content-type": "image/png" } });
      }
      return ++calls === 1 ? response([{ ...raw("1"), extended_entities: { media: [
        { type: "photo", media_url_https: "https://pbs.twimg.com/r1-fixture.png" },
      ] } }]) : Response.json({}, { status: 403 });
    } }), /403/);
  assert.equal(calls, 2); assert.equal(completions, 0); assert.equal(media, 0);
});

test("successful chunks are assembled before one answer synthesis with shared usage", async () => {
  let completions = 0;
  const registry = { getAll: () => [model], find: () => model, complete: async () => {
    completions++; return { stopReason: "stop", content: [{ type: "text", text: "Sources https://x.com/fixture/status/1 and https://x.com/fixture/status/51" }] };
  } };
  const result = await runTwitterApiTweetsByIds({ query: "q", ids: ids(51), config: config({ synthesisModel: "fixture/answer", maxPages: 2 }),
    registry, env: { TWITTERAPI_IO_API_KEY: key() }, fetcher: async input => response(sentIds(input).map(raw)) });
  assert.equal(completions, 1);
  assert.equal(result.details.synthesisCalls, 1);
  assert.equal(result.details.usage!.upstreamAttempts, 2);
  assert.equal(result.details.usage!.successfulPages, 2);
  assert.equal(result.details.usage!.postsReturned, 51);
  assert.equal(result.details.usage!.postsRetained, 51);
  assert.deepEqual(result.details.citations, ["https://x.com/fixture/status/1", "https://x.com/fixture/status/51"]);
});
