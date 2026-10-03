/**
 * twitterapi.io backend — pure request/response logic (no pi imports).
 * Testable with an injected fetcher.
 *
 * Barrel: internal wiring for the split modules (core types, params, tweet/user
 * mapping, date window, transport, search and endpoint readers). The *published*
 * surface is `src/index.ts`; `export *` here also exposes sibling-module helpers
 * to the rest of the source tree by design.
 */
export * from "./twitterapi/core.js";
export * from "./twitterapi/params.js";
export * from "./twitterapi/tweet.js";
export * from "./twitterapi/window.js";
export * from "./twitterapi/http.js";
export * from "./twitterapi/search.js";
export * from "./twitterapi/endpoints.js";
