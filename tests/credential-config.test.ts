import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTwitterConfig } from "../src/config.js";
import { registerTwitterTool } from "../src/tool.js";
import { resolveSynthesisBackend } from "../src/backend/synthesis.js";
import { cacheDirectory, withEvidenceCache } from "../src/backend/evidence-cache.js";

const settings = { twitter: { twitterIoApiKeyEnv: "MY_TWITTER_KEY", minRequestIntervalMs: 0 } };

test("retrieval credential name defaults, trims, and remains user-only", () => {
  assert.equal(loadTwitterConfig({}).twitterIoApiKeyEnv, "TWITTERAPI_IO_API_KEY");
  const config = loadTwitterConfig({ twitter: { twitterIoApiKeyEnv: " MY_TWITTER_KEY " } }, {
    projectSettings: { twitter: { twitterIoApiKeyEnv: "PROJECT_SECRET" } },
  });
  assert.equal(config.twitterIoApiKeyEnv, "MY_TWITTER_KEY");
  assert.match(config.configNotes.join(" "), /twitterIoApiKeyEnv.*user settings/);
  assert.equal(loadTwitterConfig({}, { projectSettings: settings }).twitterIoApiKeyEnv, "TWITTERAPI_IO_API_KEY");
  for (const value of ["", " key with spaces ", "key\nname", "literal-secret!", 1, {}, null]) {
    const invalid = loadTwitterConfig({ twitter: { twitterIoApiKeyEnv: value } });
    assert.equal(invalid.twitterIoApiKeyEnv, "TWITTERAPI_IO_API_KEY");
    assert.match(invalid.configNotes.join(" "), /must name an environment variable/);
    if (typeof value === "string" && value.length > 2) assert.ok(!invalid.configNotes.join(" ").includes(value));
  }
});

test("backend uses only the selected variable and does not fall back to another credential", () => {
  const config = loadTwitterConfig(settings);
  const backend = resolveSynthesisBackend({ config, output: "posts", env: { MY_TWITTER_KEY: "selected", TWITTERAPI_IO_API_KEY: "other" } });
  assert.equal(backend.apiKey, "selected");
  assert.throws(() => resolveSynthesisBackend({ config, output: "posts", env: { TWITTERAPI_IO_API_KEY: "other" } }), /MY_TWITTER_KEY/);
  const inherited = loadTwitterConfig({ twitter: { twitterIoApiKeyEnv: "constructor" } });
  assert.throws(() => resolveSynthesisBackend({ config: inherited, output: "posts", env: {} }), /constructor must be configured/);
});

test("tool reloads the configured credential name per call for evidence and answers", async () => {
  let tool: any;
  let calls = 0;
  const current = { twitter: { ...settings.twitter } };
  registerTwitterTool({ registerTool: (value: unknown) => { tool = value; } } as any, {
    settings: current,
    env: { MY_TWITTER_KEY: "selected", OTHER_TWITTER_KEY: "changed" },
    fetcher: (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("x-api-key"), calls++ === 0 ? "selected" : "changed");
      return new Response(JSON.stringify({ tweets: [{ id: "123", url: "https://x.com/user/status/123", text: "Measured source." }] }));
    }) as typeof fetch,
  });
  const registry = {
    getAll: () => [{ provider: "test", id: "model", contextWindow: 100_000, maxTokens: 4096 }],
    find: () => undefined,
    complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Answer https://x.com/user/status/123" }] }),
  };
  await tool.execute("first", { mode: "tweets", ids: ["123"], query: "Read", output: "posts" });
  current.twitter.twitterIoApiKeyEnv = "OTHER_TWITTER_KEY";
  await tool.execute("second", { mode: "tweets", ids: ["123"], query: "Read" }, undefined, undefined, {
    model: { provider: "test", id: "model" }, modelRegistry: registry,
  });
  assert.equal(calls, 2);
});

test("tool credential errors name the selected variable, not its value", async () => {
  let tool: any;
  registerTwitterTool({ registerTool: (value: unknown) => { tool = value; } } as any, { settings, env: { TWITTERAPI_IO_API_KEY: "unselected-secret" } });
  await assert.rejects(() => tool.execute("missing", { query: "Read", output: "posts" }), error => {
    assert.match(String(error), /MY_TWITTER_KEY/);
    assert.ok(!String(error).includes("unselected-secret"));
    return true;
  });
});

test("configured retrieval credentials echoed in text never enter persistent evidence", async t => {
  const dir = await mkdtemp(join(tmpdir(), "twitter-key-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadTwitterConfig({ twitter: { ...settings.twitter, evidenceCache: "read-write", enableVideoUnderstanding: true, enableVideoProcessing: true } });
  const evidence = await withEvidenceCache({
    config, postUrl: "https://x.com/user/status/123", deadline: Date.now() + 60_000, modelSupportsImage: false,
    media: { type: "video", durationMillis: 1000, videoVariants: ["https://video.twimg.com/clip.mp4"] },
    deps: { cacheAgentDir: dir, env: { MY_TWITTER_KEY: "do-not-store-this-secret" }, fetcher: async () => { throw new Error("not expected"); } },
  }, async () => ({ postUrl: "source", method: "transcript-only", frames: [], transcript: "Provider echoed do-not-store-this-secret", notes: [] }));
  assert.match(evidence.notes.join(" "), /credential value.*persistence was skipped/);
  assert.equal((await readdir(cacheDirectory(dir))).filter(name => name.endsWith(".json")).length, 0);
});
