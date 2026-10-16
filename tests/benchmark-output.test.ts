import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import benchmark, { CallBudget, reportedUsage, totalUsage, textOf, cases, failureSummary } from "../scripts/benchmark-output.js";

test("benchmark import/default factory cannot start paid work without explicit opt-in", () => {
  const old = process.env.TWITTER_BENCHMARK_APPROVED;
  delete process.env.TWITTER_BENCHMARK_APPROVED;
  try { benchmark({ on() { assert.fail("must not install a paid-run hook"); } } as never); }
  finally { if (old === undefined) delete process.env.TWITTER_BENCHMARK_APPROVED; else process.env.TWITTER_BENCHMARK_APPROVED = old; }
});

test("benchmark requires a separate output-directory opt-in too", () => {
  const old = process.env.TWITTER_BENCHMARK_APPROVED, dir = process.env.TWITTER_BENCHMARK_DIR;
  process.env.TWITTER_BENCHMARK_APPROVED = "9"; delete process.env.TWITTER_BENCHMARK_DIR;
  try { benchmark({ on() { assert.fail("directory gate required"); } } as never); }
  finally {
    if (old === undefined) delete process.env.TWITTER_BENCHMARK_APPROVED; else process.env.TWITTER_BENCHMARK_APPROVED = old;
    if (dir !== undefined) process.env.TWITTER_BENCHMARK_DIR = dir;
  }
});

for (const [kind, cap] of [["upstream", 6], ["model", 9]] as const) {
  test(`${kind} work is capped before the next invocation`, () => {
    let checkpoints = 0;
    const budget = new CallBudget(() => { checkpoints++; });
    for (let i = 0; i < cap; i++) budget.reserve(kind);
    assert.throws(() => budget.reserve(kind), /budget exhausted/);
    assert.equal(budget[kind], cap); assert.equal(checkpoints, cap);
    assert.equal(budget[kind === "upstream" ? "model" : "upstream"], 0);
  });
}

test("budget reservation is durably checkpointed before work can begin", () => {
  let invoked = 0;
  const budget = new CallBudget(() => { throw new Error("fixture ledger unavailable"); });
  assert.throws(() => { budget.reserve("model"); invoked++; }, /ledger unavailable/);
  assert.equal(invoked, 0); assert.equal(budget.model, 1);
});

test("failed SDK calls and absent/default-zero usage stay unknown", () => {
  for (const m of [null, {}, { stopReason: "stop" }, { stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0 } },
    { stopReason: "error", usage: { input: 100, output: 20 } }, { stopReason: "length", usage: { input: 100, output: 20 } }]) {
    assert.equal(reportedUsage(m), null);
  }
});

test("usage keeps provider fields without inventing absent cache or token counts", () => {
  assert.deepEqual(reportedUsage({ stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, totalTokens: 15,
    cacheWrite: -1, cost: 0.01 } }), { input: 10, output: 5, cacheRead: 0, totalTokens: 15 });
  assert.deepEqual(reportedUsage({ stopReason: "stop", usage: { input: Infinity, output: 5, cacheRead: NaN } }), { output: 5 });
});

test("an unknown or failed call cannot disappear from an alleged total", () => {
  const good = { input: 10, output: 5, cacheRead: 0, totalTokens: 15 };
  assert.deepEqual(totalUsage([good, null]), { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null });
  assert.deepEqual(totalUsage([good, { input: 2 }]), { input: 12, output: null, cacheRead: null, cacheWrite: null, totalTokens: null });
  assert.deepEqual(totalUsage([]), { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null });
});

test("token totals preserve zero cache reports only when every call reports them", () => {
  assert.deepEqual(totalUsage([{ input: 10, output: 5, cacheRead: 0 }, { input: 20, output: 6, cacheRead: 0 }]),
    { input: 30, output: 11, cacheRead: 0, cacheWrite: null, totalTokens: null });
});

test("the protocol fixes three queries across three modes, not three adaptive searches", () => {
  assert.equal(cases.length, 3); assert.equal(new Set(cases.map(c => c.mode)).size, 3);
  assert.ok(cases.every(c => c.query.length > 20));
});

test("caller text is only final text blocks, never hidden reasoning or tool metadata", () => {
  assert.equal(textOf({ content: [{ type: "thinking", text: "private" }, { type: "text", text: "Final" }, { type: "image", data: "x" }] }), "Final");
  assert.equal(textOf(null), "");
});

test("failure diagnostics classify without persisting provider messages or secrets", () => {
  const error = new Error("400 invalid reasoning_effort; credential=private-fixture-value");
  assert.deepEqual(failureSummary(error), { kind: "invalid-request", httpStatus: 400, reasoningMentioned: true });
  assert.ok(!JSON.stringify(failureSummary(error)).includes("private-fixture-value"));
  assert.deepEqual(failureSummary(undefined), { kind: "unknown", httpStatus: null, reasoningMentioned: false });
});

test("real Pi print-mode startup cannot add an enclosing model turn", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-benchmark-lifecycle-"));
  const agent = join(directory, "agent"); mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6",
    twitter: { twitterIoApiKeyEnv: "BENCHMARK_MISSING_KEY" } }));
  const marker = join(directory, "fixture-called");
  const fixture = join(directory, "provider.ts");
  writeFileSync(fixture, `import {writeFileSync} from "node:fs";
export default function(pi:any) { pi.registerProvider("benchmark-fixture", {
api:"benchmark-offline",baseUrl:"https://fixture.invalid",apiKey:"offline-fixture",
models:[{id:"fixture",name:"fixture",reasoning:false,input:["text"],contextWindow:100000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
streamSimple(model:any) { writeFileSync(${JSON.stringify(marker)},"called");
const message={role:"assistant",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:"stop",content:[{type:"text",text:"Offline fixture."}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
return {async *[Symbol.asyncIterator]() {yield {type:"start",partial:message};yield {type:"done",reason:"stop",message};},result:async()=>message}; }
}); }`);
  // The configured fixture can answer without auth or ANY network. A missing
  // real credential must not make an ineffective lifecycle guard look sound.
  const childOptions = { cwd: directory, encoding: "utf8" as const, timeout: 30000, maxBuffer: 2000000, env: {
    PATH: process.env.PATH, HOME: process.env.HOME, PI_CODING_AGENT_DIR: agent,
    TWITTER_BENCHMARK_APPROVED: "9", TWITTER_BENCHMARK_DIR: join(directory, "results"),
  } };
  // npm puts the supported-minimum local Pi ahead of a newer global Pi. Use
  // optional isolation flags only when that executable actually supports them.
  const help = spawnSync("pi", ["--help"], childOptions);
  assert.equal(help.status, 0);
  const flags = ["--offline", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve"]
    .filter(flag => help.stdout.includes(flag));
  const args = ["--no-extensions", "-e", fixture, "--provider", "benchmark-fixture", "--model", "fixture", ...flags,
    "--no-tools", "--no-session", "--mode", "json", "--print", "This enclosing prompt must never start a model turn."];
  const baseline = spawnSync("pi", args, childOptions);
  assert.equal(baseline.error, undefined);
  if (!existsSync(marker)) writeFileSync(join(directory, "baseline-diagnostic.json"), JSON.stringify({
    exit: baseline.status, stdout: baseline.stdout, stderr: baseline.stderr,
  }), { mode: 0o600 });
  assert.ok(existsSync(marker), `fixture must be callable without the benchmark guard; diagnostic: ${join(directory, "baseline-diagnostic.json")}`);
  unlinkSync(marker);
  const child = spawnSync("pi", ["-e", resolve("scripts/benchmark-output.ts"), ...args], childOptions);
  assert.ok(!existsSync(marker), "the enclosing fixture model was called outside the benchmark ledger");
  assert.equal(child.error, undefined);
  const ledger = JSON.parse(readFileSync(join(directory, "results/result.json"), "utf8"));
  assert.equal(ledger.state, "INCOMPLETE"); assert.deepEqual(ledger.budget, { upstream: 0, model: 0 });
  const events = child.stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  assert.ok(!events.some(e => e.type === "agent_start"), "the enclosing prompt escaped the benchmark input guard");
});

test("offline Pi-hook rehearsal counts full workflows, private checkpoints and refuses replay", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi-output-benchmark-fixture-"));
  const agent = join(directory, "agent"); mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ twitter: { twitterIoApiKeyEnv: "BENCHMARK_FIXTURE_KEY" } }));
  const env = { TWITTER_BENCHMARK_APPROVED: "9", TWITTER_BENCHMARK_DIR: join(directory, "results"),
    BENCHMARK_FIXTURE_KEY: "offline-benchmark-dummy-not-a-secret", PI_CODING_AGENT_DIR: agent };
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  let hook: any, fetches = 0, completions = 0, shutdowns = 0;
  const model = (provider: string, id: string) => ({ provider, id, input: ["text"], contextWindow: 1000000, maxTokens: 10000 });
  const registry = { find: model, complete: async (m: any, _context: any, options: any) => {
    completions++;
    return { stopReason: "stop", content: [{ type: "text", text: "Supported fixture https://x.com/NASA/status/2107226494934061502 https://x.com/NASA" }],
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 } };
  } };
  t.mock.method(globalThis, "fetch", async (input: any) => {
    fetches++;
    const u = new URL(String(input));
    const tweet = { id: "2107226494934061502", url: "https://x.com/NASA/status/2107226494934061502", text: "Supported fixture", author: { userName: "NASA" } };
    return Response.json(u.pathname === "/twitter/user/info" ? { data: { id: "1", userName: "NASA", name: "NASA", description: "Supported fixture", url: "https://x.com/NASA" } }
      : u.pathname === "/twitter/user/last_tweets" ? { data: { tweets: [tweet] }, has_next_page: false } : { tweets: [tweet] });
  });
  benchmark({ on(_name: string, handler: any) { hook = handler; } } as never);
  const ctx = { modelRegistry: registry, shutdown() { shutdowns++; } };
  await hook({}, ctx);
  const file = join(env.TWITTER_BENCHMARK_DIR, "result.json");
  const bytes = readFileSync(file, "utf8"), result = JSON.parse(bytes);
  assert.equal(result.state, "PASS"); assert.equal(result.rows.length, 6);
  assert.equal(fetches, 6); assert.equal(completions, 9); assert.equal(shutdowns, 1);
  assert.deepEqual(result.budget, { upstream: 6, model: 9 });
  assert.ok(result.sdk.every((s: any) => s.outcome === "success"));
  assert.ok(result.rows.filter((r: any) => r.arm === "answer").every((r: any) => r.sdkInvocations === 2 && r.usage.input === 200 && r.successfulUsage.input === 200));
  assert.ok(result.rows.filter((r: any) => r.arm === "posts").every((r: any) => r.sdkInvocations === 1 && r.usage.input === 100));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!bytes.includes(env.BENCHMARK_FIXTURE_KEY));
  await hook({}, ctx);
  assert.equal(fetches, 6); assert.equal(completions, 9); assert.equal(shutdowns, 2);
  assert.equal(readFileSync(file, "utf8"), bytes, "an existing paid ledger must remain untouched");
});
