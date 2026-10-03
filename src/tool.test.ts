import assert from "node:assert/strict";
import test from "node:test";

import { registerTwitterTool } from "./tool.js";

function captureTool() {
  let registered: any;
  const pi = {
    registerTool(tool: any) {
      registered = tool;
    },
  };
  return { pi, tool: () => registered };
}

test("registerTwitterTool registers intent-only parameters", () => {
  const { pi, tool } = captureTool();
  registerTwitterTool(pi as any, { env: { TWITTERAPI_IO_API_KEY: "key" }, settings: {} });

  const registered = tool();
  assert.equal(registered.name, "twitter");
  const properties = registered.parameters.properties;
  assert.ok(properties.query);
  assert.ok(properties.allowed_x_handles);
  assert.ok(properties.excluded_x_handles);
  assert.ok(properties.from_date);
  assert.ok(properties.to_date);
  assert.ok(properties.count);
  assert.ok(properties.queryType);
  assert.equal(properties.model, undefined);
  assert.equal(properties.enable_image_understanding, undefined);
  assert.equal(properties.enable_video_understanding, undefined);
});

test("execute rejects with actionable guidance when no credentials exist", async () => {
  const { pi, tool } = captureTool();
  registerTwitterTool(pi as any, { env: {}, settings: {} });

  await assert.rejects(
    () => tool().execute("id", { query: "q" }, undefined, undefined, undefined),
    /TWITTERAPI_IO_API_KEY/,
  );
});

test("XAI_API_KEY alone does not configure this extension", async () => {
  // There is no xAI backend here: the twitterapi.io key is the only credential.
  const { pi, tool } = captureTool();
  registerTwitterTool(pi as any, { env: { XAI_API_KEY: "key" }, settings: {} });

  await assert.rejects(
    () => tool().execute("id", { query: "q" }, undefined, undefined, undefined),
    /TWITTERAPI_IO_API_KEY/,
  );
});

test("execute retrieves through twitterapi.io and synthesizes", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const href = String(url);
    seen.push(href);
    return new Response(
      JSON.stringify({
        tweets: [
          {
            id: "1",
            url: "https://x.com/alice/status/111",
            text: "post body",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "alice", name: "Alice" },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const registry = {
    find: () => undefined,
    getAll: () => [{ provider: "anthropic", id: "haiku", input: ["text"] }],
    complete: async () => ({ content: [{ type: "text", text: "Synthesized (https://x.com/alice/status/111)." }] }),
  };

  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });
  const result = await tool().execute("id", { query: "q" }, undefined, undefined, { modelRegistry: registry });

  assert.match(seen[0], /api\.twitterapi\.io/);
  assert.match(result.content[0].text, /Model: anthropic\/haiku/);
  assert.match(result.content[0].text, /## Answer\n\nSynthesized/);
  assert.match(result.content[0].text, /1\. https:\/\/x\.com\/alice\/status\/111/);
});

test("execute explains a missing synthesis model instead of failing obscurely", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () => new Response(JSON.stringify({ tweets: [], has_next_page: false }), { status: 200 })) as unknown as typeof fetch;
  const registry = { find: () => undefined, getAll: () => [], complete: async () => ({}) };

  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/missing" } },
  });

  await assert.rejects(
    () => tool().execute("id", { query: "q" }, undefined, undefined, { modelRegistry: registry }),
    /was not found in pi's model catalogue/,
  );
});

test("execute reports when pi's model registry is unavailable", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () => new Response(JSON.stringify({ tweets: [], has_next_page: false }), { status: 200 })) as unknown as typeof fetch;

  registerTwitterTool(pi as any, { env: { TWITTERAPI_IO_API_KEY: "key" }, fetcher, settings: {} });

  await assert.rejects(
    () => tool().execute("id", { query: "q" }, undefined, undefined, undefined),
    /model registry/,
  );
});

test("execute reports that pi's ModelRegistry.complete is required, and does no network work first", async () => {
  const { pi, tool } = captureTool();
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ tweets: [], has_next_page: false }), { status: 200 });
  }) as unknown as typeof fetch;
  // A registry shaped like pi 0.80.6: find/getAll exist, complete does not.
  const legacyRegistry = {
    find: () => undefined,
    getAll: () => [{ provider: "anthropic", id: "haiku", input: ["text"] }],
  };

  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  await assert.rejects(
    () => tool().execute("id", { query: "q" }, undefined, undefined, { modelRegistry: legacyRegistry }),
    /needs pi's ModelRegistry\.complete[\s\S]*0\.80\.6/,
  );
  assert.equal(calls, 0, "compatibility must be checked before any retrieval");
});

test("execute falls back to the session model when synthesisModel is unset", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        tweets: [
          {
            id: "1",
            url: "https://x.com/alice/status/111",
            text: "post body",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "alice", name: "Alice" },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const registry = {
    find: () => undefined,
    getAll: () => [{ provider: "anthropic", id: "haiku", input: ["text"] }],
    complete: async () => ({ content: [{ type: "text", text: "Synthesized (https://x.com/alice/status/111)." }] }),
  };

  registerTwitterTool(pi as any, { env: { TWITTERAPI_IO_API_KEY: "key" }, fetcher, settings: {} });
  const result = await tool().execute("id", { query: "q" }, undefined, undefined, {
    modelRegistry: registry,
    model: { provider: "anthropic", id: "haiku" },
  });

  assert.match(result.content[0].text, /Model: anthropic\/haiku/);
  assert.match(result.content[0].text, /Synthesized/);
});

test("execute requires synthesisModel", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () => new Response(JSON.stringify({ tweets: [], has_next_page: false }), { status: 200 })) as unknown as typeof fetch;
  const registry = {
    find: () => undefined,
    getAll: () => [{ provider: "anthropic", id: "haiku", input: ["text"] }],
    complete: async () => ({ content: [{ type: "text", text: "unused" }] }),
  };

  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    // No synthesisModel configured: it has no default and must not be guessed.
    settings: { twitter: {} },
  });

  await assert.rejects(
    () => tool().execute("id", { query: "q" }, undefined, undefined, { modelRegistry: registry }),
    /needs a synthesis model/,
  );
});

test("execute surfaces a failed synthesis instead of returning an empty answer", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        tweets: [
          {
            id: "1",
            url: "https://x.com/alice/status/111",
            text: "post body",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "alice", name: "Alice" },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  // A provider failure resolves as an assistant message with stopReason "error".
  const registry = {
    find: () => undefined,
    getAll: () => [{ provider: "anthropic", id: "haiku", input: ["text"] }],
    complete: async () => ({ stopReason: "error", errorMessage: "provider overloaded", content: [] }),
  };

  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  await assert.rejects(
    () => tool().execute("id", { query: "q" }, undefined, undefined, { modelRegistry: registry }),
    /twitter synthesis failed: provider overloaded/,
  );
});

function userRegistry(text: string) {
  return {
    find: () => undefined,
    getAll: () => [{ provider: "anthropic", id: "haiku", input: ["text"] }],
    complete: async () => ({ content: [{ type: "text", text }] }),
  };
}

test("execute dispatches mode=users to account search and cites profile URLs", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(
      JSON.stringify({
        users: [
          { id: "1", screen_name: "grok", name: "Grok", description: "bio", followers_count: 100, isBlueVerified: true, url: "https://t.co/x" },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  const result = await tool().execute("id", { query: "grok", mode: "users" }, undefined, undefined, {
    modelRegistry: userRegistry("Built by (https://x.com/grok)."),
  });

  assert.match(seen[0], /\/twitter\/user\/search/, "the account endpoint is used");
  assert.ok(!/advanced_search/.test(seen[0]), "the post endpoint is not used for a user search");
  assert.match(result.content[0].text, /1\. https:\/\/x\.com\/grok/, "sources are constructed profile URLs");
});

test("execute dispatches mode=thread and requires a tweet reference", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async (url: string | URL) => {
    assert.match(String(url), /thread_context/);
    return new Response(
      JSON.stringify({
        status: "success",
        tweets: [{ id: "7", url: "https://x.com/a/status/7", text: "root", createdAt: "Thu Oct 01 12:00:00 +0000 2026", author: { userName: "a" } }],
        has_next_page: false,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  await assert.rejects(
    () => tool().execute("id", { query: "thread", mode: "thread" }, undefined, undefined, { modelRegistry: userRegistry("x") }),
    /needs a tweet/,
  );

  const result = await tool().execute("id", { query: "thread", mode: "thread", tweet: "7" }, undefined, undefined, {
    modelRegistry: userRegistry("Root post (https://x.com/a/status/7)."),
  });
  assert.match(result.content[0].text, /1\. https:\/\/x\.com\/a\/status\/7/);
});

test("execute rejects an unknown mode before doing any work", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () => {
    throw new Error("no request may be made for an invalid mode");
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });
  await assert.rejects(
    () => tool().execute("id", { query: "x", mode: "nonsense" }, undefined, undefined, { modelRegistry: userRegistry("x") }),
    /mode must be one of/,
  );
});

test("mode=thread answers the user's question, not the tweet reference", async () => {
  const { pi, tool } = captureTool();
  let seenPrompt = "";
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        status: "success",
        tweets: [{ id: "7", url: "https://x.com/a/status/7", text: "our deadline is Friday", createdAt: "Thu Oct 01 12:00:00 +0000 2026", author: { userName: "a" } }],
        has_next_page: false,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  const registry = {
    find: () => undefined,
    getAll: () => [{ provider: "anthropic", id: "haiku", input: ["text"] }],
    complete: async (_model: unknown, context: { messages: Array<{ content: unknown }> }) => {
      seenPrompt = String(context.messages[0].content);
      return { content: [{ type: "text", text: "Friday (https://x.com/a/status/7)." }] };
    },
  };

  const result = await tool().execute(
    "id",
    { query: "what deadline is announced?", mode: "thread", tweet: "7" },
    undefined,
    undefined,
    { modelRegistry: registry },
  );

  assert.match(seenPrompt, /what deadline is announced\?/, "the question reaches the synthesis prompt");
  assert.ok(!/^Question: 7$/m.test(seenPrompt), "the tweet reference must not replace the question");
  assert.match(result.content[0].text, /^Query: what deadline is announced\?/m, "the answer is labelled with the question");
  assert.match(result.content[0].text, /thread context of post 7/, "the thread is identified in Notes");
});

test("mode=users rejects parameters it cannot apply", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () => {
    throw new Error("no request may be made for an unsupported combination");
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  await assert.rejects(
    () => tool().execute("id", { query: "grok", mode: "users", excluded_x_handles: ["spam"] }, undefined, undefined, { modelRegistry: userRegistry("x") }),
    /excluded_x_handles cannot be applied in mode "users"/,
  );
  await assert.rejects(
    () => tool().execute("id", { query: "grok", mode: "users", from_date: "2026-09-01" }, undefined, undefined, { modelRegistry: userRegistry("x") }),
    /from_date cannot be applied in mode "users"/,
  );
  await assert.rejects(
    () => tool().execute("id", { query: "q", mode: "thread", tweet: "7", queryType: "Top" }, undefined, undefined, { modelRegistry: userRegistry("x") }),
    /queryType cannot be applied in mode "thread"/,
  );
});

test("configured page limits bound the new modes", async () => {
  const { pi, tool } = captureTool();
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ users: [{ id: String(calls), screen_name: `h${calls}` }], has_next_page: true, next_cursor: `c${calls}` }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku", maxPages: 1, maxPagesCeiling: 1 } },
  });

  await tool().execute("id", { query: "grok", mode: "users" }, undefined, undefined, {
    modelRegistry: userRegistry("None (https://x.com/h1)."),
  });
  assert.equal(calls, 1, "maxPagesCeiling of 1 must bound an account search");
});

test("a multi-word account query that finds nothing explains why", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () => new Response(JSON.stringify({ users: [], has_next_page: false }), { status: 200 })) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  const result = await tool().execute("id", { query: "pi coding agent", mode: "users" }, undefined, undefined, {
    modelRegistry: userRegistry("unused"),
  });
  assert.match(result.content[0].text, /no word boundaries/, "the query shape is explained");
  assert.match(result.content[0].text, /No accounts matched/, "and the empty result is honest");
});

test("mode=thread fetches the referenced thread and answers from it", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const href = String(url);
    seen.push(href);
    return new Response(
      JSON.stringify({
        tweets: [
          {
            id: "7",
            url: "https://x.com/a/status/7",
            text: "thread body",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "a", name: "A" },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const registry = userRegistry("Answer (https://x.com/a/status/7)");
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });
  const result = await tool().execute(
    "id",
    { query: "what deadline is announced?", mode: "thread", tweet: "https://x.com/a/status/7" },
    undefined,
    undefined,
    { modelRegistry: registry },
  );

  assert.match(seen[0], /api\.twitterapi\.io/, "the thread is fetched from twitterapi.io");
  assert.match(seen[0], /tweetId=7/, "the referenced post id locates the thread");
  assert.match(result.content[0].text, /## Answer/);
  assert.match(result.content[0].text, /Answer/);
});

test("mode and tweet are validated before credentials", async () => {
  const { pi, tool } = captureTool();
  registerTwitterTool(pi as any, { env: {}, settings: {} });

  await assert.rejects(
    () => tool().execute("id", { query: "x", mode: "nonsense" }, undefined, undefined, undefined),
    /mode must be one of/,
  );
  await assert.rejects(
    () => tool().execute("id", { query: "x", tweet: "7" }, undefined, undefined, undefined),
    /tweet can only be used in modes/,
  );
  await assert.rejects(
    () => tool().execute("id", { query: "x", mode: "thread", tweet: "not-a-tweet" }, undefined, undefined, undefined),
    /must be a numeric post id or an X permalink/,
  );
});

test("a blank thread question is rejected before retrieval", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () => {
    throw new Error("no request may be made for a blank question");
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });
  await assert.rejects(
    () => tool().execute("id", { query: "   ", mode: "thread", tweet: "7" }, undefined, undefined, { modelRegistry: userRegistry("x") }),
    /query must not be empty/,
  );
});

test("a configured page budget above the endpoint default still works", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () =>
    new Response(JSON.stringify({ users: [{ id: "1", screen_name: "h1" }], has_next_page: false }), { status: 200 })) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku", maxPages: 21, maxPagesCeiling: 21 } },
  });
  const result = await tool().execute("id", { query: "grok", mode: "users" }, undefined, undefined, {
    modelRegistry: userRegistry("A (https://x.com/h1)."),
  });
  assert.match(result.content[0].text, /## Sources/, "a valid config must not be rejected as an invalid bound");
});

test("a blank question is rejected before any retrieval, even in thread mode", async () => {
  // A thread reference must not turn a blank question into a non-empty one.
  const { pi, tool } = captureTool();
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, { env: {}, fetcher, settings: {} });

  await assert.rejects(
    () => tool().execute("id", { query: "   ", mode: "thread", tweet: "7" }, undefined, undefined, undefined),
    /query must not be empty/,
  );
  await assert.rejects(() => tool().execute("id", { query: "  " }, undefined, undefined, undefined), /query must not be empty/);
  assert.equal(calls, 0, "no request may be made for a blank question");
});

test("mode=users rejects post-only parameters loudly instead of ignoring them", async () => {
  const { pi, tool } = captureTool();
  const fetcher = async (): Promise<Response> => {
    throw new Error("no request may be made");
  };
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher: fetcher as unknown as typeof fetch,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });
  await assert.rejects(
    () =>
      tool().execute(
        "id",
        { query: "q", mode: "users", allowed_x_handles: ["alice"] },
        undefined,
        undefined,
        { modelRegistry: userRegistry("x") },
      ),
    /allowed_x_handles cannot be applied in mode "users"/,
  );

  await assert.rejects(
    () =>
      tool().execute(
        "id",
        { query: "q", mode: "thread", tweet: "7", from_date: "2026-10-01" },
        undefined,
        undefined,
        { modelRegistry: userRegistry("x") },
      ),
    /from_date cannot be applied in mode "thread"/,
  );
});

test("mode=user reads an account timeline and answers from it", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(
      JSON.stringify({
        tweets: [
          {
            id: "5",
            url: "https://x.com/alice/status/5",
            text: "timeline body",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "alice" },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  const result = await tool().execute(
    "id",
    { query: "what is new?", mode: "user", user: "alice" },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Answer (https://x.com/alice/status/5)") },
  );
  assert.match(seen[0], /last_tweets/);
  assert.match(seen[0], /userName=alice/);
  assert.match(result.content[0].text, /## Answer/);
});

test("mode=trends reads a location's trends and cites X search URLs", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ trends: [{ name: "#pi", target: { query: "#pi" }, rank: 1 }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  const result = await tool().execute(
    "id",
    { query: "what is trending?", mode: "trends", woeid: 1 },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Trending: #pi") },
  );
  assert.match(seen[0], /trends\?woeid=1/);
  assert.match(result.content[0].text, /Trending: #pi/);
  assert.match(result.content[0].text, /https:\/\/x\.com\/search\?q=%23pi/);
});

test("mode=replies and mode=quotes read a post's conversation", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(
      JSON.stringify({
        tweets: [
          {
            id: "8",
            url: "https://x.com/b/status/8",
            text: "reply body",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "b" },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  await tool().execute(
    "id",
    { query: "what do the replies say?", mode: "replies", tweet: "7", replySort: "Likes" },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Reply answer (https://x.com/b/status/8)") },
  );
  assert.match(seen[0], /replies\/v2/);
  assert.match(seen[0], /tweetId=7/);
  assert.match(seen[0], /queryType=Likes/);

  await tool().execute(
    "id",
    { query: "what do the quotes say?", mode: "quotes", tweet: "7", sinceTime: 100 },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Quote answer (https://x.com/b/status/8)") },
  );
  assert.match(seen[1], /quotes/);
  assert.match(seen[1], /sinceTime=100/);
});

test("the new modes validate their required parameters", async () => {
  const { pi, tool } = captureTool();
  registerTwitterTool(pi as any, { env: { TWITTERAPI_IO_API_KEY: "key" }, settings: {} });

  await assert.rejects(
    () => tool().execute("id", { query: "q", mode: "user" }, undefined, undefined, undefined),
    /needs `user` .* or `userId`/,
  );
  await assert.rejects(
    () => tool().execute("id", { query: "q", mode: "trends" }, undefined, undefined, undefined),
    /needs `woeid`/,
  );
  await assert.rejects(
    () =>
      tool().execute(
        "id",
        { query: "q", mode: "user", user: "alice", allowed_x_handles: ["a"] },
        undefined,
        undefined,
        undefined,
      ),
    /allowed_x_handles cannot be applied in mode "user"/,
  );
});

test("mode=profile reads a single account profile", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(
      JSON.stringify({ data: { id: "1", screen_name: "alice", description: "builder", followers_count: 12 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  const result = await tool().execute(
    "id",
    { query: "who is this?", mode: "profile", user: "alice" },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Alice builds things.") },
  );
  assert.match(seen[0], /user\/info/);
  assert.match(seen[0], /userName=alice/);
  assert.match(result.content[0].text, /Alice builds things/);
});

test("mode=followers and mode=followings read account graphs", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const href = String(url);
    seen.push(href);
    const body = href.includes("followings")
      ? { followings: [{ id: "2", screen_name: "bob" }] }
      : { followers: [{ id: "1", screen_name: "alice" }] };
    return new Response(JSON.stringify({ ...body, has_next_page: false }), { status: 200 });
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  await tool().execute(
    "id",
    { query: "who follows this?", mode: "followers", user: "grok" },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Followers: alice (https://x.com/alice)") },
  );
  assert.match(seen[0], /followers/);
  await tool().execute(
    "id",
    { query: "who does this follow?", mode: "followings", user: "grok" },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Following: bob (https://x.com/bob)") },
  );
  assert.match(seen[1], /followings/);
});

test("mode=mentions reads posts mentioning an account", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(
      JSON.stringify({
        tweets: [
          {
            id: "3",
            url: "https://x.com/b/status/3",
            text: "hi @grok",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "b" },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  await tool().execute(
    "id",
    { query: "what are people saying?", mode: "mentions", user: "grok", sinceTime: 100 },
    undefined,
    undefined,
    { modelRegistry: userRegistry("People are saying hi (https://x.com/b/status/3)") },
  );
  assert.match(seen[0], /mentions/);
  assert.match(seen[0], /sinceTime=100/);
});

test("mode=tweets fetches specific posts by id", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(
      JSON.stringify({
        tweets: [
          { id: "1", url: "https://x.com/a/status/1", text: "post", createdAt: "Mon Sep 21 10:00:00 +0000 2026", author: { userName: "a" } },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  await tool().execute(
    "id",
    { query: "summarise these", mode: "tweets", ids: ["1", "2"] },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Summary (https://x.com/a/status/1)") },
  );
  assert.match(seen[0], /tweet_ids=1%2C2/);

  // A permalink is canonicalised to its id before the request.
  await tool().execute(
    "id",
    { query: "summarise this permalink", mode: "tweets", ids: ["https://x.com/a/status/9"] },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Summary (https://x.com/a/status/1)") },
  );
  assert.match(seen[1], /tweet_ids=9/);
});

test("P2 modes validate their required parameters", async () => {
  const { pi, tool } = captureTool();
  registerTwitterTool(pi as any, { env: { TWITTERAPI_IO_API_KEY: "key" }, settings: {} });

  await assert.rejects(
    () => tool().execute("id", { query: "q", mode: "profile" }, undefined, undefined, undefined),
    /needs `user`/,
  );
  await assert.rejects(
    () => tool().execute("id", { query: "q", mode: "followers" }, undefined, undefined, undefined),
    /needs `user`/,
  );
  await assert.rejects(
    () => tool().execute("id", { query: "q", mode: "tweets" }, undefined, undefined, undefined),
    /needs `ids`/,
  );
});

test("mode=community, mode=list and mode=space dispatch to their endpoints", async () => {
  const { pi, tool } = captureTool();
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const href = String(url);
    seen.push(href);
    if (href.includes("spaces/detail")) {
      return new Response(JSON.stringify({ detail: { id: "sp1", title: "Live chat", state: "Live" } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        tweets: [
          {
            id: "4",
            url: "https://x.com/a/status/4",
            text: "community post",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "a" },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  await tool().execute(
    "id",
    { query: "what is in this community?", mode: "community", communityId: "123" },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Community answer (https://x.com/a/status/4)") },
  );
  assert.match(seen[0], /community\/tweets/);

  await tool().execute(
    "id",
    { query: "what is in this list?", mode: "list", listId: "456" },
    undefined,
    undefined,
    { modelRegistry: userRegistry("List answer (https://x.com/a/status/4)") },
  );
  assert.match(seen[1], /list\/tweets_timeline/);

  await tool().execute(
    "id",
    { query: "what is this space?", mode: "space", spaceId: "sp1" },
    undefined,
    undefined,
    { modelRegistry: userRegistry("Space answer.") },
  );
  assert.match(seen[2], /spaces\/detail/);
  assert.match(seen[2], /space_id=sp1/);
});

test("a failing synthesis model falls back to the session model", async () => {
  const { pi, tool } = captureTool();
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        tweets: [
          {
            id: "1",
            url: "https://x.com/alice/status/111",
            text: "post body",
            createdAt: "Mon Sep 21 10:00:00 +0000 2026",
            author: { userName: "alice" },
          },
        ],
        has_next_page: false,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const registry = {
    find: () => undefined,
    getAll: () => [
      { provider: "anthropic", id: "haiku", input: ["text"] },
      { provider: "anthropic", id: "sonnet", input: ["text"] },
    ],
    complete: async (model: { id?: string }) => {
      if (model?.id === "haiku") throw new Error("provider overloaded");
      return { content: [{ type: "text", text: "Fallback answer (https://x.com/alice/status/111)." }] };
    },
  };
  registerTwitterTool(pi as any, {
    env: { TWITTERAPI_IO_API_KEY: "key" },
    fetcher,
    settings: { twitter: { synthesisModel: "anthropic/haiku" } },
  });

  const result = await tool().execute("id", { query: "q" }, undefined, undefined, {
    modelRegistry: registry,
    model: { provider: "anthropic", id: "sonnet" },
  });
  assert.match(result.content[0].text, /Fallback answer/);
  assert.match(result.content[0].text, /produced by anthropic\/sonnet/);
});

test("P3 modes validate their required id parameters", async () => {
  const { pi, tool } = captureTool();
  registerTwitterTool(pi as any, { env: { TWITTERAPI_IO_API_KEY: "key" }, settings: {} });

  await assert.rejects(
    () => tool().execute("id", { query: "q", mode: "community" }, undefined, undefined, undefined),
    /needs `communityId`/,
  );
  await assert.rejects(
    () => tool().execute("id", { query: "q", mode: "list" }, undefined, undefined, undefined),
    /needs `listId`/,
  );
  await assert.rejects(
    () => tool().execute("id", { query: "q", mode: "space" }, undefined, undefined, undefined),
    /needs `spaceId`/,
  );
});
