import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, chmod, symlink, rm, rename, realpath, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { cachedCheckBinary } from "./backend/binary-cache.js";
import { processVideo, type ExecFn } from "./backend/video.js";
import { loadTwitterConfig } from "./config.js";

const options = { timeoutMs: 10_000 };
const success = { stdout: "test version", stderr: "" };
async function fixture(t: { after(fn: () => Promise<void> | void): void }) {
  const dir = await mkdtemp(join(tmpdir(), "twitter-binary-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "probe"); await writeFile(bin, "test executable", { mode: 0o700 });
  return { dir, bin };
}

test("successful detection is reused by resolved path and executor, without another probe", async t => {
  const { bin } = await fixture(t); let calls = 0;
  const exec: ExecFn = async () => { calls++; return success; };
  assert.equal(await cachedCheckBinary(exec, bin, options), true);
  assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 1);
});

test("one successful probe across two videos while processing still runs twice", async t => {
  const { dir, bin } = await fixture(t); let probes = 0, frames = 0;
  const exec: ExecFn = async (_file, args) => {
    if (args.includes("-version")) probes++;
    else if (args.includes("-frames:v")) { frames++; await writeFile(args.at(-1)!, "jpeg"); }
    return success;
  };
  const config = loadTwitterConfig({ twitter: { ffmpegPath: bin, maxFrames: 1, enableVideoUnderstanding: true, enableVideoProcessing: true } });
  const fetcher: typeof fetch = async () => new Response(new Uint8Array(1024), { headers: { "content-type": "video/mp4", "content-length": "1024" } });
  for (let i = 0; i < 2; i++) {
    const result = await processVideo({ postUrl: `https://x.com/a/status/${i}`, media: { type: "video", durationMillis: 10_000, videoVariants: ["https://video.twimg.com/a.mp4"] }, config,
      modelSupportsImage: true, deadline: Date.now() + 30_000, deps: { exec, fetcher, mktemp: async () => dir, rmTemp: async () => {} } });
    assert.equal(result.frames.length, 1);
  }
  assert.equal(probes, 1); assert.equal(frames, 2);
});

for (const code of ["ENOENT", "EACCES", "ETIMEDOUT", "EIO"]) test(`failed ${code} detection is not successful and can recover`, async t => {
  const { bin } = await fixture(t); let calls = 0;
  const exec: ExecFn = async () => { if (++calls === 1) throw Object.assign(new Error("probe failed"), { code }); return success; };
  assert.equal(await cachedCheckBinary(exec, bin, options), false);
  assert.equal(await cachedCheckBinary(exec, bin, options), true);
  assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 2);
});

test("generic failures are not treated as availability or permanently memoized", async t => {
  const { bin } = await fixture(t); let calls = 0;
  const exec: ExecFn = async () => { if (++calls === 1) throw new Error("generic failure"); return success; };
  assert.equal(await cachedCheckBinary(exec, bin, options), false);
  assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 2);
});

test("already cancelled caller cannot probe or use a warm hit, but does not poison it", async t => {
  const { bin } = await fixture(t); let calls = 0; const c = new AbortController(); c.abort();
  const exec: ExecFn = async () => { calls++; return success; };
  assert.equal(await cachedCheckBinary(exec, bin, { ...options, signal: c.signal }), false); assert.equal(calls, 0);
  assert.equal(await cachedCheckBinary(exec, bin, options), true);
  assert.equal(await cachedCheckBinary(exec, bin, { ...options, signal: c.signal }), false);
  assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 1);
});

test("cancelled apparently successful probe cannot seed a warm hit", async t => {
  const { bin } = await fixture(t); let calls = 0; const c = new AbortController();
  const exec: ExecFn = async () => { calls++; if (calls === 1) c.abort(); return success; };
  assert.equal(await cachedCheckBinary(exec, bin, { ...options, signal: c.signal }), false);
  assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 2);
});

test("independent concurrent misses isolate cancellation and keep another caller's success", async t => {
  const { bin } = await fixture(t); let calls = 0; const c = new AbortController();
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), finish = new Promise<void>(resolve => { release = resolve; });
  const exec: ExecFn = async (_file, _args, o) => { calls++; if (o.signal === c.signal) { ready(); await finish; } return success; };
  const cancelled = cachedCheckBinary(exec, bin, { ...options, signal: c.signal }); await started;
  assert.equal(await cachedCheckBinary(exec, bin, options), true); c.abort(); release();
  assert.equal(await cancelled, false); assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 2);
});

test("independent concurrent callers receive their own probe budgets and signals", async t => {
  const { bin } = await fixture(t); const a = new AbortController(), b = new AbortController(); let started!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { started = r; }), finish = new Promise<void>(r => { release = r; }); const captured: { signal?: AbortSignal; timeout: number }[] = [];
  const exec: ExecFn = async (_f, _a, o) => { captured.push(o); if (o.signal === a.signal) { started(); await finish; } return success; };
  const first = cachedCheckBinary(exec, bin, { timeoutMs: 1_000, signal: a.signal }); await ready;
  assert.equal(await cachedCheckBinary(exec, bin, { timeoutMs: 2_000, signal: b.signal }), true); release(); await first;
  assert.equal(captured.length, 2); assert.ok(captured[0].timeout > 0 && captured[0].timeout <= 1_000); assert.ok(captured[1].timeout > 0 && captured[1].timeout <= 2_000);
  assert.equal(captured[0].signal, a.signal); assert.equal(captured[1].signal, b.signal);
});

test("probe caps and elapsed deadline cannot seed successful cache entries", async t => {
  const { bin } = await fixture(t); let calls = 0, release!: () => void, started!: () => void;
  const pending = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { started = r; });
  const exec: ExecFn = async (_f, _a, o) => { assert.ok(o.timeout <= 5_000); if (++calls === 1) { started(); await pending; } return success; };
  const first = cachedCheckBinary(exec, bin, { timeoutMs: 300 }); await ready;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { assert.equal(await Promise.race([first, new Promise(r => { timer = setTimeout(() => r("too late"), 1_000); })]), false); }
  finally { clearTimeout(timer); release(); }
  await new Promise<void>(r => setTimeout(r, 100));
  assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 2);
});

test("invalid or exhausted budget cannot probe or reuse an otherwise warm hit", async t => {
  const { bin } = await fixture(t); let calls = 0;
  const exec: ExecFn = async () => { calls++; return success; };
  for (const timeoutMs of [0, -1, NaN, Infinity]) assert.equal(await cachedCheckBinary(exec, bin, { timeoutMs }), false);
  assert.equal(calls, 0); await cachedCheckBinary(exec, bin, options);
  assert.equal(await cachedCheckBinary(exec, bin, { timeoutMs: 0 }), false); assert.equal(calls, 1);
});

test("path override and same-path executable replacement invalidate detection", async t => {
  const { dir, bin } = await fixture(t), other = join(dir, "other"); await writeFile(other, "second", { mode: 0o700 }); let calls = 0;
  const exec: ExecFn = async () => { calls++; return success; };
  await cachedCheckBinary(exec, bin, options); await cachedCheckBinary(exec, other, options); assert.equal(calls, 2);
  await writeFile(bin, "changed executable contents"); await cachedCheckBinary(exec, bin, options); assert.equal(calls, 3);
  await rename(other, bin); await cachedCheckBinary(exec, bin, options); assert.equal(calls, 4);
});

test("executable changes during a successful probe cannot seed a stale hit", async t => {
  const { bin } = await fixture(t); let calls = 0;
  const exec: ExecFn = async () => { if (++calls === 1) await writeFile(bin, "replacement while probing"); return success; };
  assert.equal(await cachedCheckBinary(exec, bin, options), false);
  assert.equal(await cachedCheckBinary(exec, bin, options), true);
  assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 2);
});

test("symlink aliases share successful detection, retargeting invalidates", async t => {
  const { dir, bin } = await fixture(t), alias = join(dir, "alias"), other = join(dir, "other"); await writeFile(other, "other", { mode: 0o700 }); await symlink(bin, alias); let calls = 0;
  const exec: ExecFn = async () => { calls++; return success; };
  await cachedCheckBinary(exec, bin, options); await cachedCheckBinary(exec, alias, options); assert.equal(calls, 1);
  await rm(alias); await symlink(other, alias); await cachedCheckBinary(exec, alias, options); assert.equal(calls, 2);
});

test("PATH changes resolve a different executable instead of reusing a basename hit", async t => {
  const { dir, bin } = await fixture(t), otherDir = await mkdtemp(join(tmpdir(), "twitter-path-test-"));
  const old = process.env.PATH; t.after(async () => { if (old === undefined) delete process.env.PATH; else process.env.PATH = old; await rm(otherDir, { recursive: true, force: true }); });
  await writeFile(join(otherDir, "probe"), "other", { mode: 0o700 }); const files: string[] = [];
  const exec: ExecFn = async file => { files.push(file); return success; };
  process.env.PATH = dir; await cachedCheckBinary(exec, "probe", options);
  process.env.PATH = otherDir; await cachedCheckBinary(exec, "probe", options);
  assert.deepEqual(files, [await realpath(bin), await realpath(join(otherDir, "probe"))]);
});

test("successful injected executors are isolated and unresolvable binaries are not memoized", async t => {
  const { bin, dir } = await fixture(t); let a = 0, b = 0;
  const first: ExecFn = async () => { a++; return success; }, second: ExecFn = async () => { b++; return success; };
  await cachedCheckBinary(first, bin, options); await cachedCheckBinary(second, bin, options); assert.equal(a, 1); assert.equal(b, 1);
  const missing = join(dir, "missing"); await cachedCheckBinary(first, missing, options); await cachedCheckBinary(first, missing, options); assert.equal(a, 3);
});

test("unknown directory or unexecutable file identity cannot seed reusable entries", async t => {
  const { bin, dir } = await fixture(t); await chmod(bin, 0o600); let calls = 0;
  const exec: ExecFn = async () => { calls++; return success; };
  for (const target of [bin, bin, dir, dir]) assert.equal(await cachedCheckBinary(exec, target, options), true);
  assert.equal(calls, 4, "custom executor successes without a verified executable file are never reused");
});

test("permission loss invalidates a warm hit and failed detection can recover", async t => {
  const { bin } = await fixture(t); let calls = 0, denied = false;
  const exec: ExecFn = async () => { calls++; if (denied) throw Object.assign(new Error("denied"), { code: "EACCES" }); return success; };
  await cachedCheckBinary(exec, bin, options); denied = true; await chmod(bin, 0o600);
  assert.equal(await cachedCheckBinary(exec, bin, options), false); assert.equal(calls, 2);
  denied = false; await chmod(bin, 0o700); assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 3);
});

test("cancellation promptly returns despite an uncooperative probe, with no late cache write", async t => {
  const { bin } = await fixture(t); let calls = 0, release!: () => void, started!: () => void;
  const ready = new Promise<void>(r => { started = r; }), pending = new Promise<void>(r => { release = r; });
  const exec: ExecFn = async () => { if (++calls === 1) { started(); await pending; } return success; };
  const c = new AbortController(), first = cachedCheckBinary(exec, bin, { ...options, signal: c.signal }); await ready;
  c.abort(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(await Promise.race([first, new Promise(r => { timer = setTimeout(() => r("too late"), 1_000); })]), false);
  } finally { clearTimeout(timer); release(); }
  await new Promise<void>(r => setImmediate(r));
  assert.equal(await cachedCheckBinary(exec, bin, options), true); assert.equal(calls, 2);
});

test("real default runner caches one ffmpeg probe across two video calls", async t => {
  if (process.platform === "win32") { t.skip("POSIX executable wrapper"); return; }
  const run = promisify(execFile);
  try { await run("ffmpeg", ["-version"]); } catch { t.skip("ffmpeg unavailable"); return; }
  const { dir, bin } = await fixture(t), log = join(dir, "probes"), clip = join(dir, "source.mp4");
  await run("ffmpeg", ["-nostdin", "-f", "lavfi", "-i", "color=c=red:s=32x32:r=2:d=1", "-threads", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { timeout: 10_000 });
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv.includes('-version')) fs.appendFileSync(${JSON.stringify(log)}, '1');\nconst r = require('node:child_process').spawnSync('ffmpeg', process.argv.slice(2), {stdio:'inherit'});\nprocess.exit(r.status ?? 1);\n`, { mode: 0o700 });
  const bytes = await readFile(clip), config = loadTwitterConfig({ twitter: { ffmpegPath: bin, maxFrames: 1 } });
  const fetcher: typeof fetch = async () => new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } });
  for (let i = 0; i < 2; i++) {
    const result = await processVideo({ postUrl: `https://x.com/a/status/${i}`, media: { type: "video", durationMillis: 1_000, videoVariants: ["https://video.twimg.com/a.mp4"] }, config,
      modelSupportsImage: true, deadline: Date.now() + 30_000, deps: { fetcher } });
    assert.equal(result.frames.length, 1);
  }
  assert.equal(await readFile(log, "utf8"), "1");
});

for (const route of ["explicit", "PATH"]) test(`symlink-directory/.. keeps filesystem semantics for ${route} lookup`, async t => {
  if (process.platform === "win32") { t.skip("POSIX symlink path semantics"); return; }
  const { dir } = await fixture(t); await mkdir(join(dir, "real", "sub"), { recursive: true });
  await symlink(join(dir, "real", "sub"), join(dir, "link"));
  await writeFile(join(dir, "real", "probe"), "actual executable", { mode: 0o700 });
  const rawDir = `${dir}/link/..`, target = await realpath(`${rawDir}/probe`), files: string[] = [];
  const exec: ExecFn = async file => { files.push(file); return success; };
  const old = process.env.PATH;
  if (route === "PATH") {
    process.env.PATH = rawDir;
    t.after(() => { if (old === undefined) delete process.env.PATH; else process.env.PATH = old; });
  }
  const input = route === "explicit" ? `${rawDir}/probe` : "probe";
  assert.equal(await cachedCheckBinary(exec, input, options), true);
  assert.equal(await cachedCheckBinary(exec, input, options), true);
  assert.deepEqual(files, [target], "probe the same executable as OS path traversal, then reuse it");
});

test("final settlement rejects success after a queued microtask advances the deadline", async t => {
  const { dir } = await fixture(t); let clock = 0, probes = 0;
  t.mock.method(performance, "now", () => clock);
  const exec: ExecFn = async () => {
    probes++;
    queueMicrotask(() => queueMicrotask(() => { clock += 100; }));
    return success;
  };
  assert.equal(await cachedCheckBinary(exec, join(dir, "missing"), { timeoutMs: 50 }), false);
  assert.equal(probes, 1, "probe completed before the late settlement, not an early timeout");
});

test("late final settlement cannot commit a newly verified positive cache entry", async t => {
  const { bin } = await fixture(t); let clock = 0, probes = 0, armed = false, afterProbeReads = 0;
  t.mock.method(performance, "now", () => {
    // The third post-exec time check is after revalidation. Move time forward
    // in the microtask before final settlement, not during the actual probe.
    if (armed && ++afterProbeReads === 3) queueMicrotask(() => { clock += 100; });
    return clock;
  });
  const exec: ExecFn = async () => { probes++; armed = probes === 1; return success; };
  assert.equal(await cachedCheckBinary(exec, bin, { timeoutMs: 50 }), false);
  assert.ok(afterProbeReads >= 3, "time advanced after identity revalidation");
  armed = false;
  assert.equal(await cachedCheckBinary(exec, bin, options), true);
  assert.equal(probes, 2, "the timed-out call must not have seeded a hit");
});

test("cancellation queued after revalidation cannot commit a new positive", async t => {
  const { bin } = await fixture(t); let probes = 0, armed = false, afterProbeReads = 0;
  const c = new AbortController();
  t.mock.method(performance, "now", () => {
    if (armed && ++afterProbeReads === 3) queueMicrotask(() => c.abort());
    return 0;
  });
  const exec: ExecFn = async () => { probes++; armed = probes === 1; return success; };
  assert.equal(await cachedCheckBinary(exec, bin, { ...options, signal: c.signal }), false);
  assert.ok(afterProbeReads >= 3, "cancellation occurred after identity revalidation");
  armed = false;
  assert.equal(await cachedCheckBinary(exec, bin, options), true);
  assert.equal(probes, 2);
});

test("successful detection cache is bounded to 128 executable identities per runner", async t => {
  const { dir, bin } = await fixture(t); let calls = 0; const exec: ExecFn = async () => { calls++; return success; };
  await cachedCheckBinary(exec, bin, options);
  for (let i = 0; i < 128; i++) { const f = join(dir, `probe-${i}`); await writeFile(f, "binary", { mode: 0o700 }); await cachedCheckBinary(exec, f, options); }
  await cachedCheckBinary(exec, bin, options); assert.equal(calls, 130);
});
