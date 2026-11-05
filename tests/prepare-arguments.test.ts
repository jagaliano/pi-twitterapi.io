import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { prepareTwitterArguments, registerTwitterTool } from "../src/tool.js";

function registered(fetcher: typeof fetch = async () => { throw new Error("no network expected"); }) {
  let tool: any;
  registerTwitterTool({ registerTool(value: unknown) { tool = value; } } as any, {
    settings: { twitter: { minRequestIntervalMs: 0, retryBaseDelayMs: 0, maxPages: 1 } },
    env: { TWITTERAPI_IO_API_KEY: "prepare-arguments-test" }, fetcher,
  });
  return tool;
}

test("the tool wires prepareArguments so it runs before host coercion", () => {
  assert.equal(registered().prepareArguments, prepareTwitterArguments);
});

// Pi 1.5 drops null optionals, turns numeric strings into numbers and `true`
// into 1 before execute(); these raw shapes must fail before that happens.
const rejected: [string, Record<string, unknown>, RegExp][] = [
  ["null sinceTime", { query: "q", mode: "replies", tweet: "1", sinceTime: null }, /sinceTime must be a number.*null/],
  ["string sinceTime", { query: "q", mode: "replies", tweet: "1", sinceTime: "1792108800" }, /sinceTime must be a number.*string/],
  ["boolean sinceTime", { query: "q", mode: "replies", tweet: "1", sinceTime: true }, /sinceTime must be a number.*boolean/],
  ["null untilTime", { query: "q", mode: "replies", tweet: "1", untilTime: null }, /untilTime must be a number.*null/],
  ["string untilTime on quotes", { query: "q", mode: "quotes", tweet: "1", untilTime: "5" }, /untilTime must be a number.*string/],
  ["null sinceTime on mentions", { query: "q", mode: "mentions", user: "a", sinceTime: null }, /sinceTime must be a number.*null/],
  ["null mode", { query: "q", mode: null }, /mode must be a string.*null/],
  ["numeric mode", { query: "q", mode: 3 }, /mode must be a string.*number/],
  ["null output", { query: "q", output: null }, /output must be a string.*null/],
  ["null replySort", { query: "q", mode: "replies", tweet: "1", sinceTime: 1, replySort: null }, /replySort must be a string.*null/],
  ["null queryType", { query: "q", queryType: null }, /queryType must be a string.*null/],
];
for (const [name, args, pattern] of rejected) {
  test(`prepareArguments rejects ${name}`, () => {
    assert.throws(() => prepareTwitterArguments(args), pattern);
  });
}

test("prepareArguments returns valid and unrelated input unchanged by identity", () => {
  const cases: unknown[] = [
    { query: "q" },
    { query: "q", mode: "replies", tweet: "1", sinceTime: 0, untilTime: 1792108800, replySort: "Latest" },
    { query: "q", mode: "replies", tweet: "1", sinceTime: undefined },
    { query: "q", mode: "user", user: "a", limit: "5", includeReplies: "true", ids: "123" },
    { query: "q", mode: "replies", tweet: "1", sinceTime: 1.5 },
    null, "text", [1, 2],
  ];
  for (const value of cases) assert.equal(prepareTwitterArguments(value), value);
});

test("a raw null date never reaches paid retrieval through the prepared path", async () => {
  let calls = 0;
  const tool = registered(async () => { calls++; return new Response("{}", { status: 200 }); });
  const raw = { query: "q", mode: "replies", tweet: "2111389384432099459", sinceTime: null, output: "posts" };
  assert.throws(() => tool.prepareArguments(raw), /sinceTime/);
  assert.equal(calls, 0);
});

test("result renderer uses the injected keyHint and falls back to the package export", async () => {
  initTheme("dark", false);
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  const tool = registered();
  const details = { query: "q", model: "m", text: "t", synthesisCalls: 1, notes: ["n"],
    citations: Array.from({ length: 7 }, (_, i) => `https://x.com/a/status/${i + 1}`) };
  const result = { content: [{ type: "text", text: "t" }], details };
  const seen: string[] = [];
  const injected = tool.renderResult(result, { expanded: false }, theme,
    { keyHint: (key: string, text: string) => { seen.push(key); return `<${key}> ${text}`; } }).render(200).join("\n");
  assert.deepEqual(seen, ["app.tools.expand", "app.tools.expand"]);
  assert.match(injected, /2 more citations, <app\.tools\.expand> to expand/);
  assert.match(injected, /1 note\(s\), <app\.tools\.expand> to expand/);
  const fallback = tool.renderResult(result, { expanded: false }, theme, {}).render(200).join("\n");
  assert.match(fallback, /2 more citations, .*to expand/);
  assert.doesNotMatch(fallback, /<app\.tools\.expand>/);
});
