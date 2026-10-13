import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTwitterConfig } from "./config.js";
import { runTwitterApiTweetsByIds } from "./backend.js";
import { registerCacheCommand } from "./index.js";
import { cacheDirectory, TextEvidenceCache } from "./backend/evidence-cache.js";

const media = { id_str: "10", type: "video", media_url_https: "https://pbs.twimg.com/poster.jpg", video_info: { duration_millis: 1_000, variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/clip.mp4", bitrate: 256_000 }] } };
const post = (id: string, ownMedia = false) => ({ id, url: `https://x.com/user/status/${id}`, text: `post ${id}`, extended_entities: { media: ownMedia ? [media] : [] } });
const response = (value: unknown) => new Response(JSON.stringify(value));
async function temp(t: { after(fn: () => Promise<void>): void }) { const path = await mkdtemp(join(tmpdir(), "twitter-cache-integration-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }

for (const kind of ["native", "stt"] as const) {
  test(`real ${kind} preprocessing miss then rebinding hit retains fresh retrieval and zero provider/media/binary work`, async t => {
    const agentDir = await temp(t); let upstream = 0, providers = 0, mediaHttp = 0, execs = 0, root = post("1", true);
    const cfg = loadTwitterConfig({ twitter: { minRequestIntervalMs: 0, evidenceCache: "read-write", enableVideoUnderstanding: true, enableVideoProcessing: true,
      ...(kind === "native" ? { videoModel: "test", videoEndpoint: "https://native.example", videoApiKeyEnv: "NATIVE" }
        : { sttEndpoint: "https://stt.example/v1", sttModel: "whisper", sttApiKeyEnv: "STT" }) } });
    const options = { agentDir, query: "Show measured evidence.", ids: ["1"], output: "posts" as const, config: cfg, env: { TWITTERAPI_IO_API_KEY: `cache-${kind}`, NATIVE: "secret-native", STT: "secret-stt" },
      videoExec: async (_: string, args: string[]) => { execs++; if (!args.includes("-version")) await writeFile(args.at(-1)!, "audio"); return { stdout: "ffmpeg test", stderr: "" }; },
      fetcher: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api.twitterapi.io")) { upstream++; return response({ tweets: [root] }); }
        if (url.includes("video.twimg.com")) { mediaHttp++; return init?.method === "HEAD" ? new Response(null, { headers: { "content-length": "7" } }) : new Response("fixture", { headers: { "content-type": "video/mp4" } }); }
        assert.ok(!url.includes("pbs.twimg.com")); providers++;
        return kind === "native" ? response({ candidates: [{ content: { parts: [{ text: '{"visual":"Concrete visible scene.","transcript":"Measured spoken content."}' }] } }] }) : response({ text: "The speakers discuss concrete implementation details in this short video." });
      },
    };
    const miss = await runTwitterApiTweetsByIds(options); assert.equal(providers, 1); assert.equal(miss.details.synthesisCalls, 0);
    assert.ok((await readdir(cacheDirectory(agentDir))).some(name => name.endsWith(".json")));
    const before = { providers, mediaHttp, execs };
    root = { ...post("2"), quoted_tweet: post("3", true) } as typeof root;
    const hit = await runTwitterApiTweetsByIds({ ...options, ids: ["2"] });
    assert.equal(upstream, 2); assert.deepEqual({ providers, mediaHttp, execs }, before);
    assert.match(hit.markdown, /Cached text evidence/); assert.match(hit.markdown, /frames\/images were not restored/);
    assert.deepEqual(hit.details.citations, [root.url, "https://x.com/user/status/3"]); assert.ok(!hit.markdown.includes("https://x.com/user/status/1"));
    assert.match(hit.markdown, kind === "native" ? /Concrete visible scene/ : /concrete implementation/);
    for (const field of ["nativeVideoAttempts", "sttAttempts", "mediaAttempts", "mediaHeadAttempts", "synthesisAttempts"] as const) assert.equal(hit.details.usage![field], 0, field);
    assert.equal(hit.details.usage!.upstreamAttempts, 1);
    assert.equal(hit.details.usage!.postsRetained, 1);
    const files = await readdir(cacheDirectory(agentDir)); assert.equal(files.filter(name => name.endsWith(".json")).length, 1);
    for (const file of files.filter(name => name.endsWith(".json"))) { const body = await readFile(join(cacheDirectory(agentDir), file), "utf8"); assert.ok(!body.includes("secret-native") && !body.includes("secret-stt") && !body.includes("https://x.com")); }
  });
}

test("clear command requires explicit confirmation, honours cancellation, and targets only the trusted agent directory", async t => {
  const agentDir = await temp(t); const cache = new TextEvidenceCache(agentDir), epoch = await cache.prepare(true);
  await cache.put("a".repeat(64), { postUrl: "old", method: "transcript-only", transcript: "Measured speech", frames: [], notes: [] }, epoch!, { clipSeconds: 10 });
  let handler: any, confirmed = false, idle = 0; const messages: string[] = [];
  registerCacheCommand({ registerCommand: (name: string, command: any) => { assert.equal(name, "twitter-cache"); handler = command.handler; } } as any, agentDir);
  const ctx = { hasUI: true, cwd: "/not/the/cache", waitForIdle: async () => { idle++; }, ui: { confirm: async () => confirmed, notify: (text: string) => messages.push(text) } };
  await handler("clear", ctx); assert.equal(idle, 0); assert.equal((await readdir(cacheDirectory(agentDir))).filter(n => n.endsWith(".json")).length, 1);
  await assert.rejects(handler("clear", { ...ctx, hasUI: false }), /requires confirmation/);
  await assert.rejects(handler("clear --bad", ctx), /Usage/);
  confirmed = true; await handler("clear", ctx); assert.equal(idle, 1); assert.equal((await readdir(cacheDirectory(agentDir))).filter(n => n.endsWith(".json")).length, 0);
  assert.match(messages.join(" "), /Cleared 1/);
  await handler("clear --yes", { ...ctx, hasUI: false }); assert.equal(idle, 2);
});
