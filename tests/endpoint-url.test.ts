import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchFollowers,
  fetchSpaceDetail,
  fetchThread,
  fetchTrends,
  fetchTweetReplies,
  fetchTweetsByIds,
  fetchUserAbout,
  fetchUserProfile,
  searchUsers,
  type FetchLike,
} from "../src/twitterapi.js";

const key = "endpoint-url-construction-fixture";
const options = { minRequestIntervalMs: 0, maxRetries: 0 };
const cases: Array<{ name: string; run: (fetcher: FetchLike) => Promise<unknown> }> = [
  { name: "account search", run: f => searchUsers("fixture", key, f, options) },
  { name: "thread", run: f => fetchThread("1", key, f, options) },
  { name: "shared post walker", run: f => fetchTweetReplies("1", key, f, options) },
  { name: "trends", run: f => fetchTrends(1, key, f, options) },
  { name: "shared account walker", run: f => fetchFollowers("fixture", key, f, options) },
  { name: "profile", run: f => fetchUserProfile("fixture", key, f, options) },
  { name: "posts by id", run: f => fetchTweetsByIds(["1"], key, f, options) },
  { name: "space", run: f => fetchSpaceDetail("fixture", key, f, options) },
  { name: "about", run: f => fetchUserAbout("fixture", key, f, options) },
];

for (const entry of cases) {
  test(`${entry.name}: URL construction failure is safe and happens before fetch`, async t => {
    let fetches = 0;
    let constructions = 0;
    const OriginalURL = globalThis.URL;
    class FailingURL extends OriginalURL {
      constructor(input: string | URL, base?: string | URL) {
        super(input, base);
        constructions++;
        throw new TypeError("fixture-secret-in-parser-error");
      }
    }
    t.mock.method(globalThis, "URL", FailingURL);
    await assert.rejects(entry.run(async () => {
      fetches++;
      throw new Error("URL failure must prevent upstream dispatch");
    }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "Error");
      assert.equal(error.message, "twitterapi.io: invalid endpoint URL (internal error)");
      assert.ok(!error.message.includes("fixture-secret"));
      return true;
    });
    assert.equal(constructions, 1);
    assert.equal(fetches, 0);
  });
}
