import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerVideo, usesPiVideoModel } from "../src/backend/provider-video.js";
import { processVideo, type VideoDeps } from "../src/backend/video.js";
import { cacheKey } from "../src/backend/evidence-cache.js";
import { runTwitterApiTweetsByIds } from "../src/backend.js";
import { loadTwitterConfig } from "../src/config.js";
import { registerTwitterTool } from "../src/tool.js";
import { RunTelemetry } from "../src/telemetry.js";

const spec = "antigravity/gemini-2.5-flash-lite";
const model = { provider: "antigravity", id: "gemini-2.5-flash-lite", api: "antigravity-api", maxTokens: 8192, contextWindow: 100_000, input: ["text", "image"] };
const bytes = new Uint8Array([0, 255, 128, 10, 13, 42, 0]);
const json = JSON.stringify({ visual: "A measured cyan rectangle.", transcript: "Concrete spoken words." });
const message = (text = json, stopReason = "stop") => ({ stopReason, content: [{ type: "text", text }] });
const registry = (complete: (m: any, c: any, o: any) => Promise<unknown>, selected = model) => ({
  getAll: () => [selected], find: () => selected, complete,
  getApiKeyAndHeaders: () => { throw new Error("Provider credentials must never be extracted."); },
});
const call = (complete: (m: any, c: any, o: any) => Promise<unknown>) => providerVideo({
  registry: registry(complete), model: spec, bytes, prompt: "Analyse untrusted video as JSON.", signal: new AbortController().signal,
});
const config = (extra: object = {}) => loadTwitterConfig({ twitter: {
  enableVideoUnderstanding: true, enableVideoProcessing: true, videoModel: spec, minRequestIntervalMs: 0, ...extra,
} });
const media = { type: "video", durationMillis: 1000, videoVariants: ["https://video.twimg.com/clip.mp4"] };
const mediaFetch = (async (url, init) => {
  assert.equal(String(url), media.videoVariants[0], "provider traffic must not use the direct fetcher");
  return init?.method === "HEAD" ? new Response(null, { headers: { "content-length": String(bytes.length) } }) :
    new Response(bytes, { headers: { "content-type": "video/mp4" } });
}) as typeof fetch;
const baseDeps: VideoDeps = { fetcher: mediaFetch, checkBinary: async () => false, env: {} };
const pipeline = (deps: Partial<VideoDeps> = {}, extra: object = {}) => processVideo({
  config: config(extra), media, postUrl: "https://x.com/user/status/123", modelSupportsImage: false,
  deadline: Date.now() + 10_000, deps: { ...baseDeps, ...deps },
});

for (const shape of ["google", "wrapped", "openai"] as const) {
  test(`${shape} payload adaptation is idempotent for reused, cloned and fresh retry payloads`, async () => {
    const selected = { ...model, api: "openai-completions" };
    const result = await providerVideo({ model: spec, bytes, prompt: "Analyse", signal: new AbortController().signal,
      registry: registry(async (_m, _c, options) => {
        const fresh = () => shape === "openai"
          ? { messages: [{ role: "user", content: "Analyse" }], keep: true }
          : shape === "wrapped"
            ? { request: { contents: [{ role: "user", parts: [{ text: "Analyse" }] }] }, keep: true }
            : { contents: [{ role: "user", parts: [{ text: "Analyse" }] }], keep: true };
        const original = fresh();
        const once = options.onPayload(original);
        const twice = options.onPayload(once);
        const cloned = options.onPayload(JSON.parse(JSON.stringify(twice)));
        const retried = options.onPayload(fresh());
        for (const payload of [once, twice, cloned, retried]) {
          const parts = shape === "openai" ? payload.messages[0].content
            : shape === "wrapped" ? payload.request.contents[0].parts : payload.contents[0].parts;
          assert.equal(parts.filter((part: any) => part.inlineData?.mimeType === "video/mp4" || part.type === "video_url").length, 1);
          assert.equal(parts[0].text, "Analyse");
          assert.equal(payload.keep, true);
        }
        assert.deepEqual(original, fresh(), "provider-owned inputs remain unchanged");
        return message();
      }, selected),
    });
    assert.equal(result.text, json);
  });
}

for (const outcome of ["success", "hookless", "throw", "length", "unsupported"] as const) {
  test(`a retained payload hook is closed after ${outcome} settlement`, async () => {
    let hook: any;
    const result = await call(async (_m, _c, options) => {
      hook = options.onPayload;
      if (outcome === "throw") throw new Error("ordinary provider failure");
      if (outcome === "unsupported") hook({});
      if (outcome !== "hookless") hook({ contents: [{ role: "user", parts: [] }] });
      return message(json, outcome === "length" ? "length" : "stop");
    });
    if (outcome === "success") assert.equal(result.text, json);
    else assert.equal(result.text, undefined);
    assert.throws(() => hook({ contents: [{ role: "user", parts: [] }] }), /already finished/);
  });
}

for (const queued of [false, true]) {
  test(`absolute expiry ${queued ? "queued before SDK dispatch" : "at entry"} starts no SDK work`, async () => {
    let clock = queued ? 0 : 1001, calls = 0;
    if (queued) queueMicrotask(() => { clock = 1001; });
    const result = await providerVideo({ model: spec, bytes, prompt: "Analyse", signal: new AbortController().signal,
      deadline: 1000, now: () => clock, registry: registry(async () => { calls++; return message(); }),
    });
    assert.equal(calls, 0);
    assert.match(result.error!, /deadline/);
  });
}

test("the payload hook rechecks absolute expiry without waiting for its timer", async () => {
  let clock = 0;
  const result = await providerVideo({ model: spec, bytes, prompt: "Analyse", signal: new AbortController().signal,
    deadline: 1000, now: () => clock, registry: registry(async (_m, _c, options) => {
      clock = 1001;
      assert.throws(() => options.onPayload({ contents: [{ role: "user", parts: [] }] }), /deadline/);
      return message();
    }),
  });
  assert.equal(result.text, undefined);
  assert.match(result.error!, /deadline/);
});

test("absolute expiry at SDK settlement discards already-attached video evidence", async () => {
  let clock = 0;
  const telemetry = new RunTelemetry();
  const result = await providerVideo({ model: spec, bytes, prompt: "Analyse", signal: new AbortController().signal,
    deadline: 1000, now: () => clock, telemetry, registry: registry(async (_m, _c, options) => {
      options.onPayload({ contents: [{ role: "user", parts: [] }] });
      clock = 1001;
      return message();
    }),
  });
  assert.equal(result.text, undefined); assert.match(result.error!, /deadline/);
  assert.equal(telemetry.usage.nativeVideoSdkAttempts, 1);
  assert.equal(telemetry.usage.nativeVideoSdkFailures, 1);
});

test("expiry during binary detection admits no SDK or fallback work", async () => {
  let clock = 0, calls = 0, execs = 0;
  const result = await processVideo({ config: config(), media, postUrl: "source", modelSupportsImage: true, deadline: 1000,
    deps: { ...baseDeps, now: () => clock, checkBinary: async () => { clock = 1001; return true; },
      registry: registry(async (_m, _c, options) => { calls++; options.onPayload({ contents: [{ role: "user", parts: [] }] }); return message(); }),
      exec: async () => { execs++; return { stdout: "", stderr: "" }; },
    },
  });
  assert.equal(calls, 0); assert.equal(execs, 0);
  assert.equal(result.visualNotes, undefined); assert.equal(result.transcript, undefined);
  assert.match(result.notes.join(" "), /deadline expired/);
});

for (const success of [true, false]) {
  test(`expiry on native ${success ? "success" : "failure"} discards late evidence and starts no fallback`, async () => {
    let clock = 0, execs = 0;
    const result = await processVideo({ config: config({ sttEndpoint: "https://stt.example/v1", sttApiKeyEnv: "STT", sttModel: "whisper" }),
      media, postUrl: "source", modelSupportsImage: true, deadline: 1000,
      deps: { ...baseDeps, env: { STT: "fixture-stt" }, now: () => clock, checkBinary: async () => true,
        registry: registry(async (_m, _c, options) => {
          if (success) options.onPayload({ contents: [{ role: "user", parts: [] }] });
          clock = 1001;
          return message();
        }),
        exec: async () => { execs++; return { stdout: "", stderr: "" }; },
      },
    });
    assert.equal(execs, 0); assert.equal(result.visualNotes, undefined); assert.equal(result.transcript, undefined);
    assert.equal(result.frames.length, 0); assert.notEqual(result.method, "pi-provider");
    assert.match(result.notes.join(" "), /deadline expired/);
  });
}

test("expiry in a progress observer is rechecked before provider dispatch", async () => {
  let clock = 0, calls = 0;
  const result = await processVideo({ config: config(), media, postUrl: "source", modelSupportsImage: false, deadline: 1000,
    deps: { ...baseDeps, now: () => clock, progress: phase => { if (phase === "video: native analysis") clock = 1001; },
      registry: registry(async () => { calls++; return message(); }),
    },
  });
  assert.equal(calls, 0); assert.match(result.notes.join(" "), /deadline expired/);
});

test("a native phase timeout cannot start frames or STT even with a non-advancing injected clock", async t => {
  const alive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(alive));
  let execs = 0;
  const result = await processVideo({ config: config(), media, postUrl: "source", modelSupportsImage: true, deadline: 30,
    deps: { ...baseDeps, now: () => 0, checkBinary: async () => true,
      registry: registry(async () => new Promise(() => {})),
      exec: async () => { execs++; return { stdout: "", stderr: "" }; },
    },
  });
  assert.equal(execs, 0); assert.equal(result.visualNotes, undefined);
  assert.match(result.notes.join(" "), /deadline expired/);
});

for (const shape of ["google", "antigravity"] as const) {
  test(`${shape} payload receives exact video bytes without changing provider/model or extracting credentials`, async () => {
    const result = await call(async (selected, context, options) => {
      assert.equal(selected, model);
      assert.equal(context.messages.length, 1);
      assert.equal(typeof context.messages[0].content, "string");
      assert.deepEqual(Object.keys(options).sort(), ["maxTokens", "onPayload", "signal"]);
      assert.equal(options.maxTokens, 4000);
      const request = { contents: [{ role: "user", parts: [{ text: context.messages[0].content }] }] };
      const payload = shape === "google" ? { ...request, config: { keep: true } } : { project: "provider-project", request, session: "provider-session" };
      const next = options.onPayload(payload);
      const updated = shape === "google" ? next : next.request;
      assert.equal(updated.contents[0].parts[0].text, context.messages[0].content);
      assert.deepEqual(updated.contents[0].parts[1], { inlineData: { mimeType: "video/mp4", data: Buffer.from(bytes).toString("base64") } });
      assert.equal(request.contents[0].parts.length, 1, "do not mutate provider-owned input");
      if (shape === "antigravity") { assert.equal(next.project, "provider-project"); assert.equal(next.session, "provider-session"); }
      else assert.deepEqual(next.config, { keep: true });
      return message();
    });
    assert.equal(result.text, json);
    assert.equal(result.error, undefined);
  });
}

test("Pi-managed chat completions uses the measured video_url object shape", async () => {
  const selected = { ...model, provider: "openrouter", id: "google/gemini-2.5-flash-lite", api: "openai-completions" };
  const result = await providerVideo({ model: "openrouter/google/gemini-2.5-flash-lite", bytes, prompt: "Analyse", signal: new AbortController().signal,
    registry: registry(async (_m, _c, options) => {
      const payload = { messages: [{ role: "user", content: "Analyse" }], model: selected.id };
      const next = options.onPayload(payload);
      assert.deepEqual(next.messages[0].content[1], { type: "video_url", video_url: { url: `data:video/mp4;base64,${Buffer.from(bytes).toString("base64")}` } });
      assert.equal(payload.messages[0].content, "Analyse");
      return message();
    }, selected),
  });
  assert.equal(result.text, json);
});

test("hook-less providers cannot publish invented text-only video evidence", async () => {
  const result = await call(async () => message());
  assert.equal(result.text, undefined);
  assert.match(result.error!, /did not forward native video.*text-only reply was discarded/);
});

test("unsupported or malformed payloads are rejected before the provider can send them", async () => {
  for (const payload of [null, {}, { contents: [] }, { contents: [{ role: "user", parts: "bad" }] }, { messages: [{ role: "user", content: "Anthropic, not Google" }] }]) {
    const result = await call(async (_m, _c, options) => { options.onPayload(payload); assert.fail("unsupported payload was accepted"); });
    assert.equal(result.text, undefined);
    assert.match(result.error!, /does not expose a supported native-video payload/);
  }
});

for (const reason of ["length", "error", "aborted", "toolUse", undefined]) {
  test(`unsuccessful native SDK reply (${String(reason)}) is never used as evidence`, async () => {
    const result = await call(async (_m, _c, options) => {
      options.onPayload({ contents: [{ role: "user", parts: [{ text: "Analyse" }] }] });
      return { ...message(), stopReason: reason };
    });
    assert.equal(result.text, undefined);
    assert.match(result.error!, reason === "length" ? /truncated/ : /did not complete successfully/);
  });
}

test("empty replies and credential-bearing provider exceptions fail safely", async () => {
  const empty = await call(async (_m, _c, options) => {
    options.onPayload({ contents: [{ role: "user", parts: [] }] });
    return message("   ");
  });
  assert.match(empty.error!, /no text content/);
  const error = await call(async () => { throw new Error("Authorization: Bearer do-not-disclose-provider-secret"); });
  assert.match(error.error!, /call failed/);
  assert.ok(!JSON.stringify(error).includes("do-not-disclose-provider-secret"));
});

test("missing registry or unresolved model cannot trigger completion or direct Google fallback", async () => {
  let calls = 0;
  const options = { model: spec, bytes, prompt: "Analyse", signal: new AbortController().signal };
  assert.match((await providerVideo(options)).error!, /registry/);
  const missing = { find: () => undefined, getAll: () => [], complete: async () => { calls++; return message(); } };
  assert.match((await providerVideo({ ...options, registry: missing })).error!, /not found/);
  const result = await pipeline({ registry: missing, env: { GOOGLE_API_KEY: "must-not-fallback" } });
  assert.notEqual(result.method, "pi-provider");
  assert.match(result.notes.join(" "), /not found/);
  assert.equal(calls, 0);
});

test("SDK counters are separate from direct native HTTP and synthesis", async () => {
  const telemetry = new RunTelemetry();
  const reg = registry(async (_m, _c, options) => { options.onPayload({ contents: [{ role: "user", parts: [] }] }); return message(); });
  const options = { registry: reg, model: spec, bytes, prompt: "Analyse", signal: new AbortController().signal, telemetry };
  assert.equal((await providerVideo(options)).text, json);
  assert.equal(telemetry.usage.nativeVideoSdkAttempts, 1);
  assert.equal(telemetry.usage.nativeVideoSdkFailures, 0);
  await providerVideo({ ...options, registry: registry(async () => message()) });
  assert.equal(telemetry.usage.nativeVideoSdkAttempts, 2);
  assert.equal(telemetry.usage.nativeVideoSdkFailures, 1);
  assert.equal(telemetry.usage.nativeVideoAttempts, 0);
  assert.equal(telemetry.usage.synthesisAttempts, 0);
});

test("already-cancelled native work never invokes a provider", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await assert.rejects(providerVideo({ registry: registry(async () => { calls++; return message(); }), model: spec, bytes, prompt: "Analyse", signal: abort.signal }), /abort/i);
  assert.equal(calls, 0);
});

test("cancellation/deadline bounds providers that ignore the signal and rejects late payload hooks", async t => {
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  for (const cancel of [true, false]) {
    const abort = new AbortController(); let observed: AbortSignal | undefined; let hook: any;
    const timer = cancel ? setTimeout(() => abort.abort(), 15) : undefined;
    const signal = cancel ? abort.signal : AbortSignal.timeout(15);
    const started = performance.now();
    const result = await providerVideo({ model: spec, bytes, prompt: "Analyse", signal,
      registry: registry(async (_m, _c, options) => {
        observed = options.signal; hook = options.onPayload;
        return new Promise(resolve => { const late = setTimeout(() => resolve(message()), 600); t.after(() => clearTimeout(late)); });
      }),
    });
    if (timer) clearTimeout(timer);
    assert.equal(observed, signal);
    assert.equal(observed?.aborted, true);
    assert.ok(performance.now() - started < 500);
    assert.match(result.error!, /cancelled or exceeded its deadline/);
    assert.throws(() => hook({ contents: [{ role: "user", parts: [] }] }), /abort|timeout/i);
  }
});

test("pipeline binds provider text to its source and needs no GOOGLE_API_KEY", async () => {
  let calls = 0;
  const result = await pipeline({ registry: registry(async (_m, _c, options) => {
    calls++; options.onPayload({ request: { contents: [{ role: "user", parts: [] }] } }); return message();
  }) });
  assert.equal(calls, 1); assert.equal(result.method, "pi-provider");
  assert.equal(result.postUrl, "https://x.com/user/status/123");
  assert.equal(result.transcript, "Concrete spoken words.");
  assert.equal(result.visualNotes, "A measured cyan rectangle.");
  assert.match(result.notes.join(" "), /authentication and transport are managed by that provider/);
});

test("duration guards and invalid endpoint types still block Pi-provider uploads", async () => {
  let calls = 0;
  const deps = { ...baseDeps, registry: registry(async () => { calls++; return message(); }) };
  for (const durationMillis of [0, 121_000]) {
    const result = await processVideo({ config: config(), media: { ...media, durationMillis }, postUrl: "source", modelSupportsImage: false,
      deadline: Date.now() + 10_000, deps });
    assert.match(result.notes.join(" "), /native video analysis was skipped/);
  }
  const invalid = await pipeline(deps, { videoEndpointType: "typo" });
  assert.match(invalid.notes.join(" "), /not recognised/);
  assert.equal(calls, 0);
});

test("qualified references with direct endpoints or oversized inline clips are disclosed without provider work", async () => {
  let calls = 0;
  const deps = { registry: registry(async () => { calls++; return message(); }) };
  const mixed = await pipeline(deps, { videoEndpoint: "https://native.example", videoApiKeyEnv: "CUSTOM" });
  assert.match(mixed.notes.join(" "), /cannot be combined with twitter.videoEndpoint/);
  const large = await pipeline({ ...deps, inlineRawBytes: 2 });
  assert.match(large.notes.join(" "), /inline clips up to 12 MiB/);
  assert.equal(calls, 0);
});

test("native failure retains honest frame/STT fallbacks and cancellation never starts another tier", async () => {
  const result = await pipeline({ registry: registry(async () => message()) });
  assert.equal(result.visualNotes, undefined); assert.equal(result.transcript, undefined);
  assert.match(result.notes.join(" "), /did not forward native video/);
  assert.match(result.notes.join(" "), /Frames were not extracted/);
  const abort = new AbortController(); let execs = 0;
  await assert.rejects(pipeline({ signal: abort.signal, registry: registry(async () => { abort.abort(); return message(); }),
    exec: async () => { execs++; return { stdout: "", stderr: "" }; },
  }, { sttEndpoint: "https://stt.example/v1", sttApiKeyEnv: "STT", sttModel: "whisper" }), /abort/i);
  assert.equal(execs, 0);
});

test("hook-less native failure still recovers real speech through configured remote STT", async () => {
  let stt = 0;
  const result = await pipeline({ registry: registry(async () => message("invented visual must be discarded")), checkBinary: async () => true,
    env: { STT: "fixture-stt" }, fetcher: (async (url, init) => {
      if (String(url).startsWith("https://stt.example")) { stt++; return new Response(JSON.stringify({ text: "Real speech recovered from the separate audio track." })); }
      return mediaFetch(url, init);
    }) as typeof fetch,
    exec: async (_bin, args) => { await writeFile(args.at(-1)!, "audio"); return { stdout: "", stderr: "" }; },
  }, { sttEndpoint: "https://stt.example/v1", sttApiKeyEnv: "STT", sttModel: "whisper" });
  assert.equal(stt, 1); assert.equal(result.method, "transcript-only");
  assert.match(result.transcript!, /Real speech recovered/);
  assert.equal(result.visualNotes, undefined);
  assert.match(result.notes.join(" "), /text-only reply was discarded/);
});

test("Pi-managed processing bypasses persistent cache rather than reusing untracked provider identities", async t => {
  const dir = await mkdtemp(join(tmpdir(), "twitter-pi-provider-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const deps = { cacheAgentDir: dir, registry: registry(async (_m, _c, options) => {
    calls++; options.onPayload({ contents: [{ role: "user", parts: [] }] }); return message();
  }) };
  for (let i = 0; i < 2; i++) {
    const result = await pipeline(deps, { evidenceCache: "read-write" });
    assert.match(result.notes.join(" "), /Persistent evidence caching was bypassed/);
  }
  assert.equal(calls, 2); assert.deepEqual(await readdir(dir), []);
  assert.equal(await cacheKey({ config: config(), media, modelSupportsImage: false, postUrl: "source", deadline: Date.now() + 1000, deps: baseDeps }), undefined);
});

test("direct OpenAI-compatible slash ids and bare Gemini names keep their original routing", () => {
  assert.equal(usesPiVideoModel(config()), true);
  assert.equal(usesPiVideoModel(config({ videoModel: "gemini-2.5-flash-lite" })), false);
  assert.equal(usesPiVideoModel(config({ videoEndpointType: "openai-compatible", videoModel: "google/gemini-2.5-flash-lite" })), false);
});

test("answer output synthesizes native-provider evidence with the separate answer model", async () => {
  const answerModel = { ...model, provider: "test", id: "answer", input: ["text"] };
  const calls: string[] = [];
  const reg = {
    find: () => undefined, getAll: () => [model, answerModel],
    complete: async (selected: any, context: any, options: any) => {
      calls.push(`${selected.provider}/${selected.id}`);
      if (selected.id === model.id) {
        options.onPayload({ contents: [{ role: "user", parts: [] }] }); return message();
      }
      assert.match(context.messages[0].content, /Concrete spoken words/);
      return message("A cyan rectangle. https://x.com/user/status/123");
    },
  };
  const result = await runTwitterApiTweetsByIds({ ids: ["123"], query: "Describe", config: config({ synthesisModel: "test/answer" }), registry: reg,
    env: { TWITTERAPI_IO_API_KEY: "pi-video-answer-test" }, videoExec: async () => ({ stdout: "", stderr: "" }),
    fetcher: (async (url, init) => String(url).includes("api.twitterapi.io") ? new Response(JSON.stringify({ tweets: [{
      id: "123", url: "https://x.com/user/status/123", text: "Source", extended_entities: { media: [{ type: "video",
        media_url_https: "https://pbs.twimg.com/poster.jpg", video_info: { duration_millis: 1000,
          variants: [{ content_type: "video/mp4", url: media.videoVariants[0] }] } }] },
    }] })) : mediaFetch(url, init)) as typeof fetch,
  });
  assert.deepEqual(calls, [spec, "test/answer"]);
  assert.equal(result.details.usage?.nativeVideoSdkAttempts, 1);
  assert.equal(result.details.usage?.synthesisAttempts, 1);
  assert.equal(result.details.usage?.nativeVideoAttempts, 0);
  assert.equal(result.details.model, "test/answer");
});

test("evidence without both video opt-ins never accesses the model registry", async () => {
  for (const flags of [{ enableVideoUnderstanding: false, enableVideoProcessing: true }, { enableVideoUnderstanding: true, enableVideoProcessing: false }]) {
    let tool: any;
    registerTwitterTool({ registerTool: (value: unknown) => { tool = value; } } as any, {
      settings: { twitter: config(flags) }, env: { TWITTERAPI_IO_API_KEY: "disabled-native-opt-in" },
      fetcher: (async () => new Response(JSON.stringify({ tweets: [{ id: "123", url: "https://x.com/user/status/123", text: "Source" }] }))) as typeof fetch,
    });
    const result = await tool.execute("evidence", { mode: "tweets", ids: ["123"], query: "Read", output: "posts" }, undefined, undefined, {
      get model() { throw new Error("must not inspect synthesis model"); },
      get modelRegistry() { throw new Error("disabled native video must not access registry"); },
    });
    assert.equal(result.details.synthesisCalls, 0);
    assert.equal(result.details.usage.nativeVideoSdkAttempts, 0);
  }
});

test("tool evidence output accesses only the native provider, never the synthesis/session model", async () => {
  let tool: any; let nativeCalls = 0;
  const reg = registry(async (_m, _c, options) => {
    nativeCalls++; options.onPayload({ request: { contents: [{ role: "user", parts: [] }] } }); return message();
  });
  const fetcher = (async (url, init) => String(url).includes("api.twitterapi.io") ? new Response(JSON.stringify({ tweets: [{
    id: "123", url: "https://x.com/user/status/123", text: "Source text", extended_entities: { media: [{
      type: "video", media_url_https: "https://pbs.twimg.com/poster.jpg",
      video_info: { duration_millis: 1000, variants: [{ content_type: "video/mp4", url: media.videoVariants[0] }] },
    }] },
  }] })) : mediaFetch(url, init)) as typeof fetch;
  registerTwitterTool({ registerTool: (value: unknown) => { tool = value; } } as any, {
    settings: { twitter: { ...config(), synthesisModel: "missing/synthesis-model" } }, env: { TWITTERAPI_IO_API_KEY: "pi-video-tool-test" }, fetcher,
  });
  const result = await tool.execute("evidence", { mode: "tweets", ids: ["123"], query: "Describe", output: "posts" }, undefined, undefined, {
    get model() { throw new Error("evidence must not inspect session synthesis model"); }, modelRegistry: reg,
  });
  assert.equal(nativeCalls, 1);
  assert.equal(result.details.model, "none"); assert.equal(result.details.synthesisCalls, 0);
  assert.match(result.content[0].text, /Concrete spoken words/);
  assert.equal(result.details.usage.nativeVideoSdkAttempts, 1);
  assert.equal(result.details.usage.synthesisAttempts, 0);
});
