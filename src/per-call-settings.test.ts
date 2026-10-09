import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTwitterTool, type TwitterToolOptions } from "./tool.js";
import { TEST_LIMITS, TEST_IMAGE, TEST_IMAGE_BOUNDS } from "./fixtures/budget.js";

let fixture = 0;
const user = (id = "first") => ({ twitter: { synthesisModel: `test/${id}`, minRequestIntervalMs: 0 } });
const response = () => Response.json({ tweets: [{ id: "7", url: "https://x.com/a/status/7", text: "hello", author: { userName: "a" } }] });
const params = { query: "q", mode: "tweets", ids: ["7"] };
function capture(overrides: TwitterToolOptions = {}) {
  const models: string[] = [];
  let reads = 0, tool: any;
  const registry = {
    getAll: () => ["first", "second"].map(id => ({ ...TEST_LIMITS, provider: "test", id, input: ["text", "image"] })),
    find: () => undefined,
    complete: async (model: { id: string }) => { models.push(model.id); return { content: [{ type: "text", text: "ok (https://x.com/a/status/7)." }] }; },
  };
  const options: TwitterToolOptions = { env: { TWITTERAPI_IO_API_KEY: `per-call-settings-${++fixture}` }, userSettings: user(), projectSettings: {}, fetcher: (async () => { reads++; return response(); }) as typeof fetch, ...overrides };
  registerTwitterTool({ registerTool(value: any) { tool = value; } } as any, options);
  const execute = (cwd?: string) => tool.execute("id", params, undefined, undefined, { modelRegistry: registry, model: { provider: "test", id: "first" }, ...(cwd ? { cwd } : {}) });
  return { options, models, registry, execute, tool, reads: () => reads };
}
function files() {
  const root = mkdtempSync(join(tmpdir(), "pi-twitterapi-percall-"));
  const agent = join(root, "agent"), a = join(root, "a"), b = join(root, "b");
  mkdirSync(agent); mkdirSync(join(a, ".pi"), { recursive: true }); mkdirSync(join(b, ".pi"), { recursive: true });
  const writeUser = (value: unknown) => writeFileSync(join(agent, "settings.json"), JSON.stringify(value));
  const writeProject = (cwd: string, value: unknown) => writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(value));
  return { root, agent, a, b, writeUser, writeProject, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("per-call injected user and project settings change without re-registration", async () => {
  const h = capture();
  await h.execute();
  h.options.userSettings = user("second");
  await h.execute();
  assert.deepEqual(h.models, ["first", "second"]);
  h.options.projectSettings = { twitter: { maxSynthesisChars: 1_000 } };
  await assert.rejects(h.execute(), /input budget/);
  assert.equal(h.reads(), 2, "fresh budget fails before retrieval");
});

test("per-call trusted settings remain trusted and ignore project overrides", async () => {
  const h = capture({ settings: user(), userSettings: user("second"), projectSettings: { twitter: { maxSynthesisChars: 1_000 } } });
  await h.execute();
  h.options.settings = user("second");
  await h.execute();
  assert.deepEqual(h.models, ["first", "second"]);
});

test("per-call disk user/project edits apply before paid retrieval", async () => {
  const f = files();
  try {
    f.writeUser(user()); f.writeProject(f.a, {});
    const h = capture({ userSettings: undefined, projectSettings: undefined, agentDir: f.agent, cwd: f.a });
    await h.execute(f.a);
    f.writeUser(user("second"));
    await h.execute(f.a);
    assert.deepEqual(h.models, ["first", "second"]);
    f.writeProject(f.a, { twitter: { maxSynthesisChars: 1_000 } });
    await assert.rejects(h.execute(f.a), /input budget/);
    assert.equal(h.reads(), 2);
    f.writeUser({ twitter: { synthesisModel: "test/missing", minRequestIntervalMs: 0 } }); f.writeProject(f.a, {});
    await assert.rejects(h.execute(f.a), /not found in pi's model catalogue/);
    assert.equal(h.reads(), 2);
  } finally { f.cleanup(); }
});

test("per-call ctx.cwd selects each project before options.cwd fallback", async () => {
  const f = files();
  try {
    f.writeUser(user()); f.writeProject(f.a, user()); f.writeProject(f.b, user("second"));
    const h = capture({ userSettings: undefined, projectSettings: undefined, agentDir: f.agent, cwd: f.b });
    await h.execute(f.a); await h.execute(f.b); await h.execute();
    assert.deepEqual(h.models, ["first", "second", "second"]);
  } finally { f.cleanup(); }
});

test("per-call malformed project warnings appear and disappear after file repair", async () => {
  const f = files();
  try {
    const h = capture({ projectSettings: undefined, cwd: f.a });
    assert.ok(!(await h.execute(f.a)).details.notes?.some((s: string) => /is not valid JSON/.test(s)));
    writeFileSync(join(f.a, ".pi", "settings.json"), '{"twitter": {"maxPages": 2,}}');
    assert.ok((await h.execute(f.a)).details.notes.some((s: string) => /is not valid JSON/.test(s)));
    f.writeProject(f.a, user("second"));
    assert.ok(!(await h.execute(f.a)).details.notes?.some((s: string) => /is not valid JSON/.test(s)));
    assert.deepEqual(h.models, ["first", "first", "second"]);
  } finally { f.cleanup(); }
});

test("per-call new project values retain user-only security restrictions", async () => {
  const f = files();
  try {
    const downloads: string[] = [];
    const h = capture({ userSettings: { twitter: { ...user().twitter, enableImageUnderstanding: true } }, projectSettings: undefined, cwd: f.a, fetcher: (async input => {
      const url = new URL(String(input));
      if (url.hostname !== "api.twitterapi.io") { downloads.push(url.href); return new Response(Buffer.from(TEST_IMAGE.data, "base64"), { headers: { "content-type": "image/png" } }); }
      return Response.json({ tweets: [{ id: "7", url: "https://x.com/a/status/7", text: "hello", extendedEntities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/a.png" }] } }] });
    }) as typeof fetch });
    await h.execute(f.a);
    f.writeProject(f.a, { twitter: { synthesisModel: "test/second", videoEndpoint: "https://attacker.invalid", videoApiKeyEnv: "UNTRUSTED_KEY", imageInputBounds: { "test/second": TEST_IMAGE_BOUNDS }, ffmpegPath: "/untrusted/binary" } });
    const result = await h.execute(f.a);
    assert.equal(h.models[1], "second", "non-sensitive project settings still apply");
    assert.deepEqual(downloads, [], "project image bounds must not authorize downloads after reload");
    const notes = result.details.notes.join("\n");
    assert.match(notes, /from project settings was ignored/);
    for (const key of ["videoEndpoint", "videoApiKeyEnv", "imageInputBounds", "ffmpegPath"]) assert.ok(notes.includes(`twitter.${key}`));
  } finally { f.cleanup(); }
});

test("per-call user JSON errors are disclosed and cleared without reload", async () => {
  const f = files();
  try {
    f.writeUser(user());
    const h = capture({ userSettings: undefined, agentDir: f.agent });
    await h.execute();
    writeFileSync(join(f.agent, "settings.json"), "{");
    const invalid = await h.execute();
    assert.ok(invalid.details.notes.some((s: string) => /is not valid JSON/.test(s)));
    f.writeUser(user("second"));
    const repaired = await h.execute();
    assert.ok(!repaired.details.notes?.some((s: string) => /is not valid JSON/.test(s)));
    assert.deepEqual(h.models, ["first", "first", "second"]);
  } finally { f.cleanup(); }
});

test("per-call config snapshots survive overlapping calls and settings replacement", async () => {
  let release!: () => void, enter!: () => void, reads = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const h = capture({ fetcher: (async () => { if (++reads === 1) { enter(); await pending; } return response(); }) as typeof fetch });
  const first = h.execute();
  try {
    await entered;
    h.options.userSettings = user("second");
    await h.execute();
  } finally { release(); }
  await first;
  assert.deepEqual(h.models, ["second", "first"], "no shared mutable runtime config");
});
