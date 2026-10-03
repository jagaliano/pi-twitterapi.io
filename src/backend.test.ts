import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantText,
  classifySynthesisError,
  completionText,
  createFetchMedia,
  isAllowedMediaUrl,
  resolveModel,
  runTwitterApiSearch,
  runTwitterApiUserSearch,
  synthesisRetryDelayMs,
  toSynthesisModel,
  type RegistryLike,
} from "./backend.js";
import { loadTwitterConfig } from "./config.js";

function registry(models: Array<{ provider: string; id: string; input?: string[] }>): RegistryLike {
  return {
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getAll: () => models,
    complete: async () => ({}),
  };
}

test("resolveModel accepts provider/model and bare ids", () => {
  const models = registry([
    { provider: "anthropic", id: "claude-haiku", input: ["text", "image"] },
    { provider: "openai", id: "gpt", input: ["text"] },
  ]);
  assert.equal(resolveModel(models, "anthropic/claude-haiku")?.provider, "anthropic");
  assert.equal(resolveModel(models, "gpt")?.provider, "openai");
  assert.equal(resolveModel(models, "anthropic/missing"), undefined);
  assert.equal(resolveModel(models, "missing"), undefined);
});

test("resolveModel falls back to a scan when find() does not know the pair", () => {
  const models = registry([{ provider: "custom", id: "thing" }]);
  const sparse: RegistryLike = { find: () => undefined, getAll: models.getAll, complete: models.complete };
  assert.equal(resolveModel(sparse, "custom/thing")?.id, "thing");
});

test("resolveModel rejects an ambiguous bare id and points at provider/model", () => {
  const models = registry([
    { provider: "a", id: "same" },
    { provider: "b", id: "same" },
  ]);
  assert.throws(() => resolveModel(models, "same"), /ambiguous across providers \(a, b\)/);
});

test("a provider-qualified short form resolves to a namespaced model id", () => {
  // Command Code exposes `deepseek/deepseek-v4.1-flash` as the model id under
  // provider `commandcode`, and pi's own --model accepts `commandcode/deepseek-v4.1-flash`.
  const models = registry([
    { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" },
    { provider: "commandcode", id: "deepseek/deepseek-v4-flash" },
    { provider: "anthropic", id: "claude-haiku" },
  ]);

  assert.equal(resolveModel(models, "commandcode/deepseek-v4.1-flash")?.id, "deepseek/deepseek-v4.1-flash");
  assert.equal(resolveModel(models, "commandcode/deepseek/deepseek-v4.1-flash")?.id, "deepseek/deepseek-v4.1-flash");
  assert.equal(resolveModel(models, "deepseek-v4.1-flash")?.id, "deepseek/deepseek-v4.1-flash");
  // The shorter sibling must not be swallowed by the longer one's suffix.
  assert.equal(resolveModel(models, "commandcode/deepseek-v4-flash")?.id, "deepseek/deepseek-v4-flash");
  assert.equal(resolveModel(models, "commandcode/deepseek-v5"), undefined);
  assert.equal(resolveModel(models, "other/deepseek-v4.1-flash"), undefined, "another provider must not match");
});

test("an ambiguous short form is rejected with its candidates", () => {
  const models = registry([
    { provider: "commandcode", id: "vendor/deepseek-v4.1-flash" },
    { provider: "commandcode", id: "other/deepseek-v4.1-flash" },
  ]);
  assert.throws(() => resolveModel(models, "commandcode/deepseek-v4.1-flash"), /matches several models/);
});

test("a missing synthesis model reports what is actually available", async () => {
  const config = loadTwitterConfig({ twitter: { synthesisModel: "commandcode/nope" } });
  const neverCalled = (async () => {
    throw new Error("no request may be made");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      runTwitterApiUserSearch({
        query: "x",
        config,
        env: { TWITTERAPI_IO_API_KEY: "k" },
        fetcher: neverCalled,
        registry: registry([{ provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" }]),
      }),
    /Known models for "commandcode": commandcode\/deepseek\/deepseek-v4\.1-flash/,
  );
});

test("toSynthesisModel reports image support from the model input list", () => {
  assert.equal(toSynthesisModel({ provider: "anthropic", id: "vision", input: ["text", "image"] }).supportsImage, true);
  assert.equal(toSynthesisModel({ provider: "openai", id: "text-only", input: ["text"] }).supportsImage, false);
  assert.equal(toSynthesisModel({ provider: "openai", id: "unknown" }).supportsImage, false);
});

test("assistantText joins text blocks and ignores everything else", () => {
  assert.equal(
    assistantText({
      content: [
        { type: "text", text: "first" },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "second" },
      ],
    }),
    "first\nsecond",
  );
  assert.equal(assistantText({ content: "not-an-array" }), "");
  assert.equal(assistantText(null), "");
  assert.equal(assistantText(undefined), "");
});

// ------------------------------------------------------- media download gates

function imageResponse(body: BodyInit, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "image/jpeg", ...headers } });
}

test("isAllowedMediaUrl accepts only HTTPS Twitter media hosts", () => {
  assert.equal(isAllowedMediaUrl("https://pbs.twimg.com/media/x.jpg"), true);
  assert.equal(isAllowedMediaUrl("https://video.twimg.com/x.mp4"), true);
  assert.equal(isAllowedMediaUrl("http://pbs.twimg.com/media/x.jpg"), false, "plain http is refused");
  assert.equal(isAllowedMediaUrl("https://localhost/x.jpg"), false);
  assert.equal(isAllowedMediaUrl("https://127.0.0.1/x.jpg"), false);
  assert.equal(isAllowedMediaUrl("https://evil.example/x.jpg"), false);
  assert.equal(isAllowedMediaUrl("https://pbs.twimg.com.evil.example/x.jpg"), false, "suffix spoofing is refused");
  assert.equal(isAllowedMediaUrl("not a url"), false);
});

test("createFetchMedia never requests a disallowed media URL", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return imageResponse("x");
  }) as unknown as typeof fetch;
  const fetchMedia = createFetchMedia(fetcher);
  assert.equal(await fetchMedia("https://127.0.0.1/secret.png"), undefined);
  assert.equal(await fetchMedia("http://pbs.twimg.com/x.png"), undefined);
  assert.equal(calls, 0, "no request may be made for a rejected URL");
});

test("createFetchMedia rejects non-image and declared-oversized responses before reading", async () => {
  let readAttempts = 0;
  const probe = (response: Response) => {
    const original = response.body?.getReader.bind(response.body);
    if (!original) return response;
    Object.defineProperty(response, "body", {
      get() {
        return {
          getReader: () => {
            readAttempts += 1;
            return original();
          },
        };
      },
    });
    return response;
  };

  const fetcher = (async (url: string) =>
    probe(
      String(url).includes("html")
        ? new Response("<html>not an image</html>", { status: 200, headers: { "content-type": "text/html" } })
        : imageResponse("x", { "content-length": "999999999" }),
    )) as unknown as typeof fetch;

  const fetchMedia = createFetchMedia(fetcher, undefined, { maxBytes: 16 });
  assert.equal(await fetchMedia("https://pbs.twimg.com/html"), undefined);
  assert.equal(await fetchMedia("https://pbs.twimg.com/huge.jpg"), undefined);
  assert.equal(readAttempts, 0, "body must not be read for rejected responses");
});

test("createFetchMedia enforces the byte cap while streaming rather than after buffering", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array(8)); // 40 bytes total
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = (async () => new Response(stream, { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;

  const fetchMedia = createFetchMedia(fetcher, undefined, { maxBytes: 16 });
  assert.equal(await fetchMedia("https://pbs.twimg.com/big.jpg"), undefined);
  assert.equal(cancelled, true, "an over-cap stream must be cancelled, not drained");

  const okStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  const okFetcher = (async () => new Response(okStream, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
  const result = await createFetchMedia(okFetcher, undefined, { maxBytes: 16 })("https://pbs.twimg.com/small.png");
  assert.equal(result?.mimeType, "image/png");
  assert.equal(result?.data, "AQID");
});

test("createFetchMedia honours its deadline and the caller's cancellation", async () => {
  const stalled = (async (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

  const timedOut = await createFetchMedia(stalled, undefined, { timeoutMs: 15 })("https://pbs.twimg.com/stall.jpg");
  assert.equal(timedOut, undefined, "a stalled download must give up on its own deadline");

  const controller = new AbortController();
  controller.abort();
  const preAborted = await createFetchMedia(stalled, controller.signal, { timeoutMs: 5_000 })("https://pbs.twimg.com/x.jpg");
  assert.equal(preAborted, undefined, "an aborted caller must not download at all");

  const live = new AbortController();
  const started = Date.now();
  const pending = createFetchMedia(stalled, live.signal, { timeoutMs: 30_000 })("https://pbs.twimg.com/y.jpg");
  setTimeout(() => live.abort(), 15);
  assert.equal(await pending, undefined);
  assert.ok(Date.now() - started < 5_000, "caller cancellation must end the download promptly");
});

test("completionText rejects failed, aborted, tool-calling, and empty completions", () => {
  assert.equal(completionText({ stopReason: "stop", content: [{ type: "text", text: "ok" }] }), "ok");
  // The provider reports failure but still resolves: this must not become an
  // empty-but-successful answer.
  assert.throws(
    () => completionText({ stopReason: "error", errorMessage: "quota exceeded", content: [] }),
    /twitter synthesis failed: quota exceeded/,
  );
  assert.throws(() => completionText({ stopReason: "aborted", content: [] }), /cancelled/);
  assert.throws(() => completionText({ stopReason: "toolUse", content: [] }), /call a tool/);
  assert.throws(() => completionText({ stopReason: "length", content: [] }), /output limit/);
  assert.throws(() => completionText({ stopReason: "stop", content: [] }), /empty answer/);
  assert.throws(() => completionText({ content: [] }), /empty answer/);
  assert.throws(() => completionText(undefined), /empty answer/);
  // A truncated-but-non-empty answer is still usable.
  assert.equal(completionText({ stopReason: "length", content: [{ type: "text", text: "partial" }] }), "partial");
});

test("notes the pages spent trimming out-of-window posts", async () => {
  const config = loadTwitterConfig({ twitter: { synthesisModel: "anthropic/haiku", minRequestIntervalMs: 0 } });
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    const createdAt = calls === 1 ? "Fri Sep 25 23:00:00 +0000 2026" : "Fri Sep 25 12:00:00 +0000 2026";
    return new Response(
      JSON.stringify({
        tweets: [{ id: String(calls), url: `https://x.com/a/status/${calls}`, text: "hi", createdAt, author: { userName: "a" } }],
        has_next_page: calls < 2,
        next_cursor: `c${calls}`,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const reg = registry([{ provider: "anthropic", id: "haiku", input: ["text"] }]);
  reg.complete = async () => ({ content: [{ type: "text", text: "cited (https://x.com/a/status/2)" }] });

  const { details, markdown } = await runTwitterApiSearch({
    params: { query: "x", count: 1, from_date: "2026-09-25", to_date: "2026-09-25" },
    config,
    env: { TWITTERAPI_IO_API_KEY: "k" },
    fetcher,
    registry: reg,
    localUtcOffsetMinutes: 120,
  });

  assert.ok(details.notes?.some((n) => /outside the requested local window/.test(n)), "the trimming is disclosed");
  assert.match(markdown, /## Notes/);
  assert.match(markdown, /6h past local midnight/, "the note names the actual band size");
});

test("an explicit invalid page budget is rejected rather than clamped into validity", async () => {
  const config = loadTwitterConfig({ twitter: { synthesisModel: "anthropic/haiku", maxPages: 5, maxPagesCeiling: 10 } });
  const neverCalled = (async () => {
    throw new Error("no request may be made with an invalid budget");
  }) as unknown as typeof fetch;

  for (const bad of [Number.POSITIVE_INFINITY, 20.5, 0, -1, Number.NaN]) {
    await assert.rejects(
      () =>
        runTwitterApiUserSearch({
          query: "x",
          config,
          env: { TWITTERAPI_IO_API_KEY: "k" },
          fetcher: neverCalled,
          registry: registry([{ provider: "anthropic", id: "haiku", input: ["text"] }]),
          maxPages: bad,
        }),
      /maxPages must be a positive integer/,
      `${String(bad)} must be rejected`,
    );
  }
});

// --------------------------------------------- synthesis failure chain

function tweetsOnce(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        tweets: [
          { id: "1", url: "https://x.com/a/status/1", text: "t", createdAt: "Mon Sep 21 10:00:00 +0000 2026", author: { userName: "a" } },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

function chainRegistry(
  complete: (model: { provider: string; id: string }) => Promise<unknown>,
): RegistryLike {
  return {
    find: () => undefined,
    getAll: () => [
      { provider: "anthropic", id: "haiku", input: ["text"] },
      { provider: "anthropic", id: "sonnet", input: ["text"] },
    ],
    complete: complete as never,
  };
}

test("classifySynthesisError maps provider failures to kinds", () => {
  assert.equal(classifySynthesisError(new Error("twitter synthesis failed: insufficient_quota")), "quota");
  assert.equal(classifySynthesisError(new Error("402 payment required")), "quota");
  assert.equal(classifySynthesisError(new Error("401 unauthorized")), "auth");
  assert.equal(classifySynthesisError(new Error("403 forbidden")), "auth");
  assert.equal(classifySynthesisError(new Error("404 model does not exist")), "unknown-model");
  assert.equal(classifySynthesisError(new Error("400 invalid request")), "invalid-request");
  assert.equal(classifySynthesisError(new Error("422 malformed")), "invalid-request");
  assert.equal(classifySynthesisError(new Error("429 too many requests")), "rate-limit");
  assert.equal(classifySynthesisError(new Error("overloaded_error")), "rate-limit");
  assert.equal(classifySynthesisError(new Error("503 service unavailable")), "server");
  assert.equal(classifySynthesisError(new Error("fetch failed: socket hang up")), "transport");
  assert.equal(classifySynthesisError(new Error("premature stream ended")), "transport");
  assert.equal(classifySynthesisError(new Error("twitter synthesis returned an empty answer")), "empty");
  assert.equal(
    classifySynthesisError(new Error("twitter synthesis was cancelled before it produced an answer")),
    "cancelled",
  );
  // Explicit codes win over text heuristics.
  assert.equal(classifySynthesisError(new Error("429 quota exceeded per minute")), "rate-limit");
  assert.equal(classifySynthesisError(new Error("insufficient_quota 429")), "quota");
  // "aborted" from a provider is transport, not caller cancellation.
  assert.equal(classifySynthesisError(new Error("connection aborted")), "transport");
  assert.equal(classifySynthesisError(new Error("x"), AbortSignal.abort()), "cancelled");
  const abortError = new Error("stop");
  abortError.name = "AbortError";
  assert.equal(classifySynthesisError(abortError), "cancelled");
  assert.equal(
    classifySynthesisError(new Error("twitter synthesis tried to call a tool instead of answering")),
    "invalid-request",
  );
  assert.equal(classifySynthesisError(new Error("maximum context length exceeded")), "invalid-request");
  assert.equal(classifySynthesisError(new Error("something inexplicable")), "unknown");
});

test("a text-only fallback does not receive images", async () => {
  const config = loadTwitterConfig({ twitter: { synthesisModel: "anthropic/haiku", enableImageUnderstanding: true } });
  const seen: { model: string; hasImage: boolean }[] = [];
  const registry = {
    find: () => undefined,
    getAll: () => [
      { provider: "anthropic", id: "haiku", input: ["text", "image"] },
      { provider: "anthropic", id: "sonnet", input: ["text"] },
    ],
    complete: async (model: { id?: string }, context: { messages?: { content?: unknown }[] }) => {
      const content = context?.messages?.[0]?.content;
      const hasImage =
        Array.isArray(content) && content.some((block) => (block as { type?: string }).type === "image");
      seen.push({ model: model.id ?? "", hasImage });
      if (model.id === "haiku") throw new Error("401 unauthorized");
      return { content: [{ type: "text", text: "fallback (https://x.com/a/status/1)" }] };
    },
  } as unknown as RegistryLike;
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/media/")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return new Response(
      JSON.stringify({
        tweets: [
          {
            id: "1",
            url: "https://x.com/a/status/1",
            text: "t",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "a" },
            entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/x.jpg" }] },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await runTwitterApiSearch({
    params: { query: "q" },
    config,
    env: { TWITTERAPI_IO_API_KEY: "k" },
    registry,
    fetcher,
    fallbackModelIds: ["anthropic/sonnet"],
    synthesisSleep: async () => {},
  });

  assert.equal(seen[0]?.model, "haiku");
  assert.equal(seen[0]?.hasImage, true, "the image-capable primary receives the image");
  assert.equal(seen[1]?.model, "sonnet");
  assert.equal(seen[1]?.hasImage, false, "the text-only fallback must not receive images");
  assert.match(result.details.notes?.join(" ") ?? "", /images were omitted/);
});

test("synthesisRetryDelayMs doubles to a 4s cap", () => {
  assert.equal(synthesisRetryDelayMs(0), 500);
  assert.equal(synthesisRetryDelayMs(1), 1_000);
  assert.equal(synthesisRetryDelayMs(2), 2_000);
  assert.equal(synthesisRetryDelayMs(3), 4_000);
  assert.equal(synthesisRetryDelayMs(5), 4_000);
});

test("an auth failure on the configured model moves to the next model", async () => {
  const seen: string[] = [];
  const registry = chainRegistry(async (model) => {
    seen.push(model.id);
    if (model.id === "haiku") throw new Error("401 unauthorized: invalid api key");
    return { content: [{ type: "text", text: "fallback (https://x.com/a/status/1)" }] };
  });
  const config = loadTwitterConfig({ twitter: { synthesisModel: "anthropic/haiku" } });
  const result = await runTwitterApiSearch({
    params: { query: "q" },
    config,
    env: { TWITTERAPI_IO_API_KEY: "k" },
    registry,
    fetcher: tweetsOnce(),
    fallbackModelIds: ["anthropic/sonnet"],
    synthesisSleep: async () => {},
  });
  assert.deepEqual(seen, ["haiku", "sonnet"], "auth is deterministic, so the next model is tried");
  assert.match(result.details.notes?.join(" ") ?? "", /produced by anthropic\/sonnet/);
});

test("a retryable failure on the last model is retried once", async () => {
  let calls = 0;
  const delays: number[] = [];
  const registry = chainRegistry(async () => {
    calls += 1;
    if (calls === 1) throw new Error("429 too many requests");
    return { content: [{ type: "text", text: "ok (https://x.com/a/status/1)" }] };
  });
  const config = loadTwitterConfig({ twitter: { synthesisModel: "anthropic/haiku" } });
  const result = await runTwitterApiSearch({
    params: { query: "q" },
    config,
    env: { TWITTERAPI_IO_API_KEY: "k" },
    registry,
    fetcher: tweetsOnce(),
    synthesisSleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(calls, 2, "the last model is retried once");
  assert.deepEqual(delays, [500]);
  assert.match(result.details.text, /ok/);
});

test("a deterministic failure on the last model is not retried", async () => {
  let calls = 0;
  const registry = chainRegistry(async () => {
    calls += 1;
    throw new Error("401 unauthorized: invalid api key");
  });
  const config = loadTwitterConfig({ twitter: { synthesisModel: "anthropic/haiku" } });
  await assert.rejects(
    () =>
      runTwitterApiSearch({
        params: { query: "q" },
        config,
        env: { TWITTERAPI_IO_API_KEY: "k" },
        registry,
        fetcher: tweetsOnce(),
        synthesisSleep: async () => {},
      }),
    /unauthorized/,
  );
  assert.equal(calls, 1, "auth failures are deterministic and never retried");
});

test("a cancellation stops the chain without trying the fallback", async () => {
  const seen: string[] = [];
  const registry = chainRegistry(async (model) => {
    seen.push(model.id);
    throw new Error("twitter synthesis was cancelled before it produced an answer");
  });
  const config = loadTwitterConfig({ twitter: { synthesisModel: "anthropic/haiku" } });
  await assert.rejects(
    () =>
      runTwitterApiSearch({
        params: { query: "q" },
        config,
        env: { TWITTERAPI_IO_API_KEY: "k" },
        registry,
        fetcher: tweetsOnce(),
        fallbackModelIds: ["anthropic/sonnet"],
        synthesisSleep: async () => {},
      }),
    /cancelled/,
  );
  assert.deepEqual(seen, ["haiku"], "cancellation is not routed around");
});
