import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { RedirectError as BarrelRedirectError } from "../src/twitterapi.js";
import { RedirectError, requestWithRetry } from "../src/twitterapi/http.js";

const options = {
  maxRetries: 0, retryBaseDelayMs: 1, timeoutMs: 3000,
  minRequestIntervalMs: 0, sleep: async () => {},
};

test("every credential-bearing API attempt refuses redirects, including retries", async () => {
  let calls = 0;
  const result = await requestWithRetry("https://api.twitterapi.io/twitter/tweets", "http-retry-fixture", async (_url, init) => {
    assert.equal(init?.redirect, "manual", "inspect but never automatically follow redirects");
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "http-retry-fixture");
    calls++;
    if (calls === 1) throw new TypeError("fixture transport error");
    return new Response("{}", { status: calls === 2 ? 429 : calls === 3 ? 503 : 200 });
  }, { ...options, maxRetries: 3 });
  assert.equal(calls, 4);
  assert.equal(result.response.status, 200);
  assert.equal(result.attempts, 4);
});

test("redirect response bodies are discarded without waiting or exposing Location", async () => {
  let cancelled = false;
  let calls = 0;
  await assert.rejects(requestWithRetry("https://api.twitterapi.io/twitter/tweets", "http-body-fixture", async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() {
      cancelled = true;
      // Cleanup must not hold a refused request open or turn it into a timeout.
      return new Promise<void>(() => {});
    } }), { status: 302, headers: { Location: "https://fixture-user:fixture-secret@other.invalid/private" } });
  }, { ...options, maxRetries: 3, sleep: async () => assert.fail("redirects must not retry") }), {
    constructor: RedirectError,
    name: "RedirectError",
    message: "twitterapi.io responded with an HTTP redirect (302); refusing to follow it with the API key.",
  });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("opaque redirects fail explicitly without body reads, retries, or leaked metadata", async () => {
  let calls = 0;
  let bodyReads = 0;
  let sleeps = 0;
  await assert.rejects(requestWithRetry("https://api.twitterapi.io/twitter/tweets", "http-opaque-fixture", async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    // A browser-style filtered redirect exposes no HTTP status, headers, or body.
    const response = Response.error();
    Object.defineProperty(response, "type", { value: "opaqueredirect" });
    response.json = async () => { bodyReads++; throw new SyntaxError("opaque body is unavailable"); };
    return response;
  }, { ...options, maxRetries: 3, sleep: async () => { sleeps++; } }), {
    constructor: RedirectError,
    name: "RedirectError",
    message: "twitterapi.io responded with an HTTP redirect (opaque response); refusing to follow it with the API key.",
  });
  assert.equal(calls, 1);
  assert.equal(bodyReads, 0);
  assert.equal(sleeps, 0);
});

test("RedirectError exposes one class through both transport and barrel imports", () => {
  assert.equal(BarrelRedirectError, RedirectError);
  const error = new BarrelRedirectError(307);
  assert.ok(error instanceof RedirectError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "RedirectError");
});

test("a status-zero error response is not misclassified as an opaque redirect", async () => {
  let calls = 0;
  const result = await requestWithRetry("https://api.twitterapi.io/twitter/tweets", "http-error-response-fixture", async () => {
    calls++;
    return Response.error();
  }, { ...options, maxRetries: 3, sleep: async () => assert.fail("error responses must not retry") });
  assert.equal(calls, 1);
  assert.equal(result.response.type, "error");
  assert.equal(result.response.status, 0);
  assert.equal(result.body, undefined);
});

test("native fetch never forwards the API key to redirect destinations", async () => {
  const fixtureKey = "http-local-fixture-not-a-secret";
  let destinationCalls = 0;
  let destinationCredentials = 0;
  let initialCalls = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/redirect/")) {
      initialCalls++;
      assert.equal(req.headers["x-api-key"], fixtureKey);
      const { port } = server.address() as { port: number };
      // A different origin even on the same machine (hostname + port vs IPv4).
      res.writeHead(Number(req.url.split("/").at(-1)), { location: `http://localhost:${port}/destination` }).end();
    } else {
      destinationCalls++;
      if (req.headers["x-api-key"]) destinationCredentials++;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let sleeps = 0;
  try {
    const { port } = server.address() as { port: number };
    for (const status of [301, 302, 303, 307, 308]) {
      await assert.rejects(requestWithRetry(`http://127.0.0.1:${port}/redirect/${status}`, fixtureKey, fetch,
        { ...options, maxRetries: 3, sleep: async () => { sleeps++; } }), {
        constructor: RedirectError,
        name: "RedirectError",
        message: `twitterapi.io responded with an HTTP redirect (${status}); refusing to follow it with the API key.`,
      });
    }
    assert.equal(initialCalls, 5, "one attempt per redirect even when retries are configured");
    assert.equal(sleeps, 0, "redirects never enter backoff");
    assert.equal(destinationCalls, 0, "no request may follow Location");
    assert.equal(destinationCredentials, 0, "the custom API-key header must never reach the other origin");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
