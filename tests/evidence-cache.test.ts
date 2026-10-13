import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, writeFile, chmod, stat, symlink, unlink, mkdir, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTwitterConfig } from "../src/config.js";
import { TextEvidenceCache, cacheDirectory, cacheKey, withEvidenceCache, CACHE_TTL_MS } from "../src/backend/evidence-cache.js";
import type { ProcessVideoInput, VideoEvidence } from "../src/backend/video.js";

const cfg = (extra: object = {}) => loadTwitterConfig({ twitter: { evidenceCache: "read-write", enableVideoUnderstanding: true, enableVideoProcessing: true, sttEndpoint: "https://stt.example/v1", sttModel: "whisper", sttApiKeyEnv: "TEST_STT", ...extra } });
const media = { type: "video", durationMillis: 10_000, url: "https://pbs.twimg.com/poster.jpg", videoVariants: ["https://video.twimg.com/clip.mp4?tag=12"], videoVariantsDetailed: [{ url: "https://video.twimg.com/clip.mp4?tag=12", bitrate: 256_000 }] };
const result = (postUrl = "https://x.com/a/status/1"): VideoEvidence => ({ postUrl, method: "transcript-only", transcript: "[00:00] Concrete measured speech.", frames: [], notes: [] });
const input = (agentDir: string, extra: Partial<ProcessVideoInput> = {}): ProcessVideoInput => ({ postUrl: "https://x.com/a/status/1", media, config: cfg(), modelSupportsImage: false, deadline: Date.now() + 60_000, deps: { cacheAgentDir: agentDir, env: { TEST_STT: "secret-not-to-persist" }, fetcher: async () => { throw new Error("not expected"); } }, ...extra });
async function temp(t: { after(fn: () => Promise<void>): void }) { const path = await mkdtemp(join(tmpdir(), "twitter-cache-test-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function entries(dir: string) { return (await readdir(cacheDirectory(dir))).filter(name => name.endsWith(".json")); }

test("cache defaults off and project settings cannot opt in or override user cache policy", () => {
  assert.equal(loadTwitterConfig({}).evidenceCache, "off");
  for (const mode of ["off", "read", "write", "read-write"]) {
    const c = loadTwitterConfig({ twitter: { evidenceCache: mode } }, { projectSettings: { twitter: { evidenceCache: "write" } } });
    assert.equal(c.evidenceCache, mode); assert.match(c.configNotes.join(" "), /evidenceCache.*user settings/);
  }
  for (const value of ["typo", null, 1, [], { toString: null }]) {
    const invalid = loadTwitterConfig({ twitter: { evidenceCache: value } });
    assert.equal(invalid.evidenceCache, "off"); assert.match(invalid.configNotes.join(" "), /evidenceCache/);
  }
});

test("off performs no cache I/O and preserves normal work", async t => {
  const dir = await temp(t); let calls = 0;
  await withEvidenceCache(input(dir, { config: cfg({ evidenceCache: "off" }) }), async () => { calls++; return result(); });
  assert.equal(calls, 1); assert.deepEqual(await readdir(dir), []);
});

test("valid hit skips all processing, rebinds to current source, discloses time/method and missing images", async t => {
  const dir = await temp(t); let calls = 0;
  const first = input(dir), second = input(dir, { postUrl: "https://x.com/other/status/2", modelSupportsImage: true, allowFrames: true });
  await withEvidenceCache(first, async () => { calls++; return { ...result(), method: "frames+stt", frames: [{ data: "SECRET_FRAME", mimeType: "image/jpeg", label: "old post frame" }] }; });
  const hit = await withEvidenceCache(second, async () => { calls++; throw new Error("cache must avoid media/provider/binary work"); });
  assert.equal(calls, 1); assert.equal(hit.postUrl, second.postUrl); assert.equal(hit.transcript, result().transcript); assert.deepEqual(hit.frames, []);
  assert.match(hit.notes.join(" "), /Cached text evidence.*\d{4}-\d\d-\d\d.*frames\+stt/);
  assert.match(hit.notes.join(" "), /frames.*not.*restored/i);
  const files = await entries(dir); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const text = await readFile(join(cacheDirectory(dir), files[0]), "utf8");
  for (const forbidden of [first.postUrl, second.postUrl, "SECRET_FRAME", "secret-not-to-persist", "video.twimg.com", "stt.example"]) assert.ok(!text.includes(forbidden), forbidden);
  assert.equal((await stat(cacheDirectory(dir))).mode & 0o777, 0o700);
  assert.equal((await stat(join(cacheDirectory(dir), files[0]))).mode & 0o777, 0o600);
});

test("provider/endpoint/model/clip/language/filter/variant changes miss, credentials never enter keys", async t => {
  const dir = await temp(t), base = input(dir), key = await cacheKey(base);
  assert.match(key!, /^[a-f0-9]{64}$/);
  assert.equal(await cacheKey({ ...base, deps: { ...base.deps, env: { TEST_STT: "another-secret" } } }), key);
  for (const extra of [ { videoEndpointType: "openai-compatible" }, { videoEndpoint: "https://native.example/v1", videoApiKeyEnv: "NATIVE" }, { videoModel: "different" }, { sttEndpoint: "https://other.example/v1" }, { sttModel: "other" }, { sttLanguage: "es" }, { maxVideoSeconds: 5 }, { maxVideoBytes: 1024 }, { maxFrames: 1 }, { videoBudgetMs: 30_000 }, { whisperRealtimeFactor: 1 }, { whisperThreads: 1 } ]) {
    assert.notEqual(await cacheKey({ ...base, config: cfg(extra) }), key, JSON.stringify(extra));
  }
  assert.notEqual(await cacheKey({ ...base, media: { ...media, videoVariantsDetailed: [{ url: "https://video.twimg.com/different.mp4", bitrate: 256_000 }] } }), key);
  assert.notEqual(await cacheKey({ ...base, deps: { ...base.deps, env: {} } }), key);
});

test("local model replacement at the same path invalidates evidence without executing binaries", async t => {
  const dir = await temp(t), model = join(dir, "model.bin"); await writeFile(model, "first");
  const i = input(dir, { config: cfg({ whisperModelPath: model, whisperCppBinary: "whisper-does-not-exist" }) });
  const a = await cacheKey(i); await writeFile(model, "changed model"); assert.notEqual(await cacheKey(i), a);
});

for (const field of ["ffmpegPath", "whisperCppBinary", "whisperModelPath", "whisperVadModelPath"] as const) {
  for (const viaPath of field === "ffmpegPath" || field === "whisperCppBinary" ? [false, true] : [false]) {
    test(`${field} symlink/.. ${viaPath ? "PATH" : "explicit"} traversal fingerprints the file actually used`, async t => {
      const dir = await temp(t), name = "traversal-probe", actual = join(dir, "real", name), shadow = join(dir, name);
      await mkdir(join(dir, "real", "sub"), { recursive: true });
      await symlink(join(dir, "real", "sub"), join(dir, "link"));
      const executable = field === "ffmpegPath" || field === "whisperCppBinary";
      const body = (text: string) => executable ? `#!/bin/sh\nprintf '%s' '${text}'\n` : text;
      await writeFile(actual, body("first evidence"), { mode: executable ? 0o700 : 0o600 });
      await writeFile(shadow, body("wrong evidence"), { mode: executable ? 0o700 : 0o600 });
      const traversal = `${dir}/link/..`, requested = viaPath ? name : `${traversal}/${name}`;
      if (viaPath) {
        const previous = process.env.PATH;
        process.env.PATH = traversal;
        t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
      }
      const i = input(dir, { config: cfg({ [field]: requested }) }), key = await cacheKey(i);
      assert.equal(key, await cacheKey({ ...i, config: cfg({ [field]: actual }) }), "identity must match OS traversal, not lexical normalization");
      let calls = 0;
      const run = async () => {
        calls++;
        const transcript = executable ? (await promisify(execFile)(requested, [])).stdout : await readFile(requested, "utf8");
        return { ...result(), transcript };
      };
      assert.equal((await withEvidenceCache(i, run)).transcript, "first evidence");
      await writeFile(shadow, body("changed shadow evidence"));
      assert.equal(await cacheKey(i), key, "unrelated lexical shadow must not invalidate evidence");
      assert.equal((await withEvidenceCache(i, run)).transcript, "first evidence");
      assert.equal(calls, 1);
      await writeFile(actual, body("replacement evidence"));
      assert.notEqual(await cacheKey(i), key, "actual file replacement must invalidate evidence");
      assert.equal((await withEvidenceCache(i, run)).transcript, "replacement evidence");
      assert.equal(calls, 2);
    });
  }
}

test("absent executable PATH bypasses persistence rather than guessing a local identity", async t => {
  const dir = await temp(t), previous = process.env.PATH;
  delete process.env.PATH;
  t.after(() => { if (previous !== undefined) process.env.PATH = previous; });
  let calls = 0;
  for (let n = 0; n < 2; n++) {
    const e = await withEvidenceCache(input(dir), async () => { calls++; return result(); });
    assert.match(e.notes.join(" "), /cache.*unavailable/i);
  }
  assert.equal(calls, 2); assert.deepEqual(await readdir(dir), []);
});

test("read/write switches are independent and off leaves stored files until explicit clear", async t => {
  const dir = await temp(t); let calls = 0;
  const run = async () => { calls++; return result(); };
  await withEvidenceCache(input(dir), run);
  await withEvidenceCache(input(dir, { config: cfg({ evidenceCache: "read" }) }), run); assert.equal(calls, 1);
  await withEvidenceCache(input(dir, { config: cfg({ evidenceCache: "write" }) }), run); assert.equal(calls, 2);
  await withEvidenceCache(input(dir, { config: cfg({ evidenceCache: "off" }) }), run); assert.equal(calls, 3); assert.equal((await entries(dir)).length, 1);
  assert.equal(await new TextEvidenceCache(dir).clear(), 1); assert.equal((await entries(dir)).length, 0);
});

test("read-only misses create no directory and never store newly produced text", async t => {
  const dir = await temp(t); await withEvidenceCache(input(dir, { config: cfg({ evidenceCache: "read" }) }), async () => result());
  assert.deepEqual(await readdir(dir), []);
});

for (const kind of ["empty", "frames-only", "failed", "cancelled"] as const) {
  test(`${kind} evidence is never written as a successful text hit`, async t => {
    const dir = await temp(t), controller = new AbortController(), i = input(dir); i.deps.signal = controller.signal;
    await withEvidenceCache(i, async () => {
      if (kind === "cancelled") controller.abort();
      return { ...result(), ...(kind === "empty" ? { transcript: " " } : kind === "frames-only" ? { method: "frames-only" as const } : kind === "failed" ? { cacheable: false } : {}) };
    });
    assert.equal((await entries(dir)).length, 0);
  });
}

test("corrupt/schema-invalid/oversized/expired/future entries miss without failing paid work", async t => {
  const dir = await temp(t); let calls = 0; const i = input(dir), run = async () => { calls++; return result(); };
  await withEvidenceCache(i, run); const file = join(cacheDirectory(dir), (await entries(dir))[0]), good = JSON.parse(await readFile(file, "utf8"));
  for (const body of ["{broken", JSON.stringify({ ...good, schema: 99 }), JSON.stringify({ ...good, transcript: " " }), JSON.stringify({ ...good, postUrl: i.postUrl }), "x".repeat(128_001), JSON.stringify({ ...good, analysedAt: Date.now() - CACHE_TTL_MS - 1 }), JSON.stringify({ ...good, analysedAt: Date.now() + 60_000 })]) {
    await writeFile(file, body, { mode: 0o600 }); const before = calls; await withEvidenceCache(i, run); assert.equal(calls, before + 1);
  }
});

test("private cache rejects symlink directories/files and broad permissions without altering targets", async t => {
  const dir = await temp(t), outside = join(dir, "outside"); await mkdir(outside); await symlink(outside, cacheDirectory(dir));
  let calls = 0; const run = async () => { calls++; return result(); };
  const fallback = await withEvidenceCache(input(dir), run); assert.equal(calls, 1); assert.match(fallback.notes.join(" "), /cache.*unavailable/i); assert.deepEqual(await readdir(outside), []);
  await rm(cacheDirectory(dir)); await withEvidenceCache(input(dir), run);
  const file = join(cacheDirectory(dir), (await entries(dir))[0]), target = join(dir, "keep"); await writeFile(target, "do not change"); await rm(file); await symlink(target, file);
  await withEvidenceCache(input(dir), run); assert.equal(await readFile(target, "utf8"), "do not change");
  assert.equal(await new TextEvidenceCache(dir).clear(), 1); assert.equal(await readFile(target, "utf8"), "do not change");
  await chmod(cacheDirectory(dir), 0o755); const broad = await withEvidenceCache(input(dir), run); assert.match(broad.notes.join(" "), /cache.*unavailable/i);
});

test("concurrent writers are atomic and bounded; eviction is oldest analysis first", async t => {
  const dir = await temp(t), cache = new TextEvidenceCache(dir, { maxBytes: 1_200, maxEntries: 2 });
  const epoch = await cache.prepare(true);
  await Promise.all(Array.from({ length: 8 }, (_, n) => cache.put(String(n).padStart(64, "0"), result(), epoch!, { clipSeconds: 10 })));
  const files = await entries(dir); assert.ok(files.length <= 2); let total = 0;
  for (const file of files) { total += (await stat(join(cacheDirectory(dir), file))).size; JSON.parse(await readFile(join(cacheDirectory(dir), file), "utf8")); }
  assert.ok(total <= 1_200); assert.ok(!(await readdir(cacheDirectory(dir))).some(name => name.startsWith(".tmp")));
});

test("clear invalidates writes already processing and does not delete unrelated files", async t => {
  const dir = await temp(t), cache = new TextEvidenceCache(dir), epoch = await cache.prepare(true);
  await cache.put("a".repeat(64), result(), epoch!, { clipSeconds: 10 });
  await writeFile(join(cacheDirectory(dir), "unrelated.txt"), "keep");
  assert.equal(await cache.clear(), 1);
  await cache.put("b".repeat(64), result(), epoch!, { clipSeconds: 10 });
  assert.equal((await entries(dir)).length, 0); assert.equal(await readFile(join(cacheDirectory(dir), "unrelated.txt"), "utf8"), "keep");
});

test("byte cap independently evicts oldest entries and expires on analysis time, not access", async t => {
  const dir = await temp(t); let now = 1_000;
  const cache = new TextEvidenceCache(dir, { maxBytes: 550, maxEntries: 100, now: () => now }), epoch = await cache.prepare(true);
  const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
  await cache.put(a, result(), epoch!, { clipSeconds: 10 }); now++;
  await cache.put(b, result(), epoch!, { clipSeconds: 10 }); now++;
  await cache.put(c, result(), epoch!, { clipSeconds: 10 });
  assert.equal(await cache.get(a, epoch!), undefined); assert.ok(await cache.get(c, epoch!));
  const bytes = await Promise.all((await entries(dir)).map(name => stat(join(cacheDirectory(dir), name)).then(s => s.size)));
  assert.ok(bytes.reduce((a, b) => a + b, 0) <= 550);
  now += CACHE_TTL_MS; assert.equal(await cache.get(c, epoch!), undefined);
});

test("unsafe endpoint identities bypass persistence without putting credentials in files", async t => {
  const dir = await temp(t); let calls = 0;
  for (const endpoint of ["https://stt.example/v1?key=do-not-store", "https://user:secret@stt.example/v1"]) {
    const e = await withEvidenceCache(input(dir, { config: cfg({ sttEndpoint: endpoint }) }), async () => { calls++; return result(); });
    assert.match(e.notes.join(" "), /cache.*unavailable/i);
  }
  assert.equal(calls, 2); assert.deepEqual(await readdir(dir), []);
});

test("clear read barrier prevents an old generation from returning text", async t => {
  const dir = await temp(t), cache = new TextEvidenceCache(dir), epoch = await cache.prepare(true), key = "a".repeat(64);
  await cache.put(key, result(), epoch!, { clipSeconds: 10 }); await cache.clear();
  // Simulate a copied entry arriving after clear. Its old generation is not reusable.
  await writeFile(join(cacheDirectory(dir), `${key}.json`), JSON.stringify({ schema: 1, epoch, key, analysedAt: Date.now(), method: "transcript-only", transcript: "old", clipSeconds: 10 }), { mode: 0o600 });
  assert.equal(await cache.get(key, epoch!), undefined);
});

test("partial atomic writes clean up temporary text on cancellation", async t => {
  const dir = await temp(t), controller = new AbortController();
  const cache = new TextEvidenceCache(dir, { signal: controller.signal }), epoch = await cache.prepare(true);
  // Filesystem notifications can arrive after put finishes. Abort at the real
  // temporary-file sync boundary instead, before the entry can be committed.
  const handle = await open(join(dir, "handle-prototype"), "w", 0o600);
  const prototype = Object.getPrototypeOf(handle) as typeof handle, sync = prototype.sync;
  await handle.close();
  let synced = false;
  t.mock.method(prototype, "sync", async function (this: typeof handle) {
    await sync.call(this); synced = true; controller.abort();
  });
  await assert.rejects(cache.put("a".repeat(64), { ...result(), transcript: "speech ".repeat(10_000) }, epoch!, { clipSeconds: 10 }), /abort/i);
  assert.ok(synced, "cancellation must occur after temporary data was written");
  assert.equal((await entries(dir)).length, 0); assert.ok(!(await readdir(cacheDirectory(dir))).some(name => name.startsWith(".tmp")));
});

test("orphan temporary files are pruned only under the writer lock", async t => {
  const dir = await temp(t), cache = new TextEvidenceCache(dir), epoch = await cache.prepare(true);
  const name = `.tmp-${randomUUID()}`; await writeFile(join(cacheDirectory(dir), name), "old text", { mode: 0o600 });
  await cache.put("a".repeat(64), result(), epoch!, { clipSeconds: 10 }); assert.ok(!(await readdir(cacheDirectory(dir))).includes(name));
});

test("special cache files cannot block reads and corrupt entries can be explicitly erased", async t => {
  const dir = await temp(t), cache = new TextEvidenceCache(dir), epoch = await cache.prepare(true), file = join(cacheDirectory(dir), `${"a".repeat(64)}.json`);
  assert.equal(spawnSync("mkfifo", ["-m", "600", file]).status, 0);
  await assert.rejects(cache.get("a".repeat(64), epoch!), /Unsafe cache file/);
  assert.equal(await cache.clear(), 1);
});

test("fresh process reuses disk text without any in-memory evidence or provider work", async t => {
  const dir = await temp(t), initial = input(dir);
  await withEvidenceCache(initial, async () => result());
  const script = `import {withEvidenceCache} from './src/backend/evidence-cache.ts';
    const input=JSON.parse(process.argv[1]); input.postUrl='https://x.com/other/status/2'; input.deadline=Date.now()+30000;
    const e=await withEvidenceCache(input,async()=>{throw Error('Unexpected cache miss')});
    console.log(JSON.stringify({url:e.postUrl,frames:e.frames.length,transcript:e.transcript,cached:e.notes.some(n=>n.includes('Cached text'))}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(initial)], { timeout: 20_000 });
  assert.deepEqual(JSON.parse(stdout), { url: "https://x.com/other/status/2", frames: 0, transcript: "[00:00] Concrete measured speech.", cached: true });
});

test("valid read-write hits need not wait for a busy or abandoned writer lock", async t => {
  const dir = await temp(t); await withEvidenceCache(input(dir), async () => result());
  await mkdir(join(cacheDirectory(dir), ".lock"), { mode: 0o700 });
  let calls = 0; const hit = await withEvidenceCache(input(dir), async () => { calls++; return result(); });
  assert.equal(calls, 0); assert.match(hit.notes.join(" "), /Cached text evidence/);
});

test("a lookup timeout must not poison storage after longer provider work", async t => {
  const dir = await temp(t);
  await withEvidenceCache(input(dir), async () => { await new Promise(resolve => setTimeout(resolve, 1_100)); return result(); });
  assert.equal((await entries(dir)).length, 1);
});

test("cache lock waits respect the remaining video deadline without starting paid work", async t => {
  const dir = await temp(t); await mkdir(cacheDirectory(dir), { mode: 0o700 }); await mkdir(join(cacheDirectory(dir), ".lock"), { mode: 0o700 });
  let calls = 0; const start = performance.now();
  const e = await withEvidenceCache(input(dir, { deadline: Date.now() + 50 }), async () => { calls++; return result(); });
  assert.equal(calls, 0); assert.match(e.notes.join(" "), /deadline expired/); assert.ok(performance.now() - start < 300);
});

test("a symlink to a valid private external entry must not become a text hit", async t => {
  const dir = await temp(t), original = input(dir); await withEvidenceCache(original, async () => result());
  const name = (await entries(dir))[0], location = join(cacheDirectory(dir), name), outside = join(dir, "external.json");
  await writeFile(outside, await readFile(location), { mode: 0o600 }); await unlink(location); await symlink(outside, location);
  let calls = 0; await withEvidenceCache(original, async () => { calls++; return result(); }); assert.equal(calls, 1);
  assert.ok((await readFile(outside, "utf8")).includes("Concrete measured speech"));
});

test("known runtime credential echoes are never persisted or returned as cache hits", async t => {
  const dir = await temp(t), initial = input(dir), leaked = { ...result(), transcript: "echo secret-not-to-persist" };
  const e = await withEvidenceCache(initial, async () => leaked); assert.equal((await entries(dir)).length, 0); assert.match(e.notes.join(" "), /credential value/);
  const cache = new TextEvidenceCache(dir), epoch = await cache.prepare(true), key = (await cacheKey(initial))!;
  await cache.put(key, leaked, epoch!, { clipSeconds: 10 }); // Simulate tampered or pre-existing text.
  let calls = 0; await withEvidenceCache(initial, async () => { calls++; return result(); }); assert.equal(calls, 1);
});

test("already cancelled or timed-out processing cannot read a hit or start work", async t => {
  const dir = await temp(t); await withEvidenceCache(input(dir), async () => result());
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await withEvidenceCache({ ...input(dir), deps: { ...input(dir).deps, signal: controller.signal } }, async () => { calls++; return result(); }).catch(() => undefined);
  await withEvidenceCache(input(dir, { deadline: Date.now() - 1 }), async () => { calls++; return result(); }).catch(() => undefined);
  assert.equal(calls, 0);
});
