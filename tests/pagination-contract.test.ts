import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchFollowers,
  fetchTweetReplies,
  fetchUserTweets,
  normalizeParams,
  searchTweets,
  searchUsers,
  type FetchLike,
  type SearchTermination,
} from "../src/twitterapi.js";

const routes = ["posts", "users", "replies", "reply-window", "timeline", "followers"] as const;
type Route = typeof routes[number];
interface Page {
  entries: Array<number | null>;
  more: boolean;
  cursor?: string;
}
interface Scenario {
  name: string;
  pages: Page[];
  ids: string[];
  stoppedBy: SearchTermination;
  truncated: boolean;
  maxPages?: number;
}
const scenarios: Scenario[] = [
  { name: "empty page with fresh cursor preserves later results", pages: [
    { entries: [], more: true, cursor: "c1" }, { entries: [1], more: false },
  ], ids: ["1"], stoppedBy: "exhausted", truncated: false },
  { name: "unusable page with fresh cursor preserves later results", pages: [
    { entries: [null], more: true, cursor: "c1" }, { entries: [1], more: false },
  ], ids: ["1"], stoppedBy: "exhausted", truncated: false },
  { name: "duplicate-only middle page preserves later results", pages: [
    { entries: [1], more: true, cursor: "c1" }, { entries: [1], more: true, cursor: "c2" },
    { entries: [2], more: false },
  ], ids: ["1", "2"], stoppedBy: "exhausted", truncated: false },
  { name: "empty pages with fresh cursors remain bounded and truncated", pages: [
    { entries: [], more: true, cursor: "c1" }, { entries: [], more: true, cursor: "c2" },
  ], ids: [], stoppedBy: "page-cap", truncated: true, maxPages: 2 },
  { name: "empty exhausted page stops without extra requests", pages: [
    { entries: [], more: false, cursor: "ignored" },
  ], ids: [], stoppedBy: "exhausted", truncated: false },
  { name: "empty page with missing cursor discloses truncation", pages: [
    { entries: [], more: true },
  ], ids: [], stoppedBy: "cursor-missing", truncated: true },
  { name: "empty cursor cycle stops without extra requests", pages: [
    { entries: [], more: true, cursor: "c1" }, { entries: [], more: true, cursor: "c1" },
  ], ids: [], stoppedBy: "cursor-cycle", truncated: true },
];

function entry(id: number | null, accounts: boolean): unknown {
  if (id === null) return null;
  return accounts
    ? { id: String(id), userName: `fixture${id}`, name: `Fixture ${id}` }
    : { id: String(id), text: `Fixture post ${id}`, url: `https://x.com/fixture/status/${id}`,
      author: { userName: "fixture", name: "Fixture" } };
}

async function read(route: Route, key: string, fetcher: FetchLike, maxPages: number) {
  const options = { maxPages, maxRetries: 0, minRequestIntervalMs: 0 };
  switch (route) {
    case "posts": return searchTweets(normalizeParams({ query: "fixture", count: 50 }), key, fetcher, options);
    case "users": return searchUsers("fixture", key, fetcher, { ...options, count: 50 });
    case "replies": return fetchTweetReplies("1", key, fetcher, { ...options, limit: 50 });
    case "reply-window": return fetchTweetReplies("1", key, fetcher, { ...options, limit: 50, sinceTime: 0, untilTime: 1000 });
    case "timeline": return fetchUserTweets({ userName: "fixture" }, key, fetcher, { ...options, limit: 50 });
    case "followers": return fetchFollowers("fixture", key, fetcher, { ...options, limit: 50 });
  }
}

for (const route of routes) {
  for (const scenario of scenarios) {
    test(`${route}: ${scenario.name}`, async () => {
      const seen: string[] = [];
      const fetcher: FetchLike = async (input, init) => {
        assert.equal(init?.redirect, "manual");
        const url = new URL(String(input));
        assert.equal(url.origin, "https://api.twitterapi.io");
        if (route === "reply-window") {
          assert.equal(url.pathname, "/twitter/tweet/replies");
          assert.equal(url.searchParams.get("sinceTime"), "0");
          assert.equal(url.searchParams.get("untilTime"), "1000");
          assert.equal(url.searchParams.has("queryType"), false);
        }
        const page = scenario.pages[seen.length];
        assert.ok(page, "pagination must not dispatch beyond the expected bound");
        const expectedCursor = seen.length === 0 ? "" : scenario.pages[seen.length - 1].cursor;
        assert.equal(url.searchParams.get("cursor") ?? "", expectedCursor);
        seen.push(url.pathname);
        const entries = page.entries.map(id => entry(id, route === "users" || route === "followers"));
        const body = {
          has_next_page: page.more, next_cursor: page.cursor,
          ...(route === "timeline" ? { data: { tweets: entries } }
            : route === "followers" ? { followers: entries }
            : route === "users" ? { users: entries } : { tweets: entries }),
        };
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      };
      const details = await read(route, `pagination-contract:${route}:${scenario.name}`, fetcher, scenario.maxPages ?? 4);
      const items = "tweets" in details ? details.tweets : details.users;
      assert.deepEqual(items.map(item => item.id), scenario.ids);
      assert.equal(details.pagesFetched, scenario.pages.length);
      assert.equal(seen.length, scenario.pages.length);
      assert.equal(details.stoppedBy, scenario.stoppedBy);
      assert.equal(details.truncated, scenario.truncated);
    });
  }
}
