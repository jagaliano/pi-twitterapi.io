# pi-twitterapi.io

A [twitterapi.io](https://twitterapi.io)-backed X/Twitter search extension for the
[pi coding agent](https://pi.dev). It registers a `twitter` tool that retrieves
posts, accounts or a thread from twitterapi.io and synthesizes an answer with
citation URLs using a model from pi's own registry.

This package is standalone and has no dependency on `@pi-lab/xsearch` or any
other extension. It deliberately does **not** offer an xAI backend: twitterapi.io
is the retrieval source, and pi's model registry performs the synthesis.

## Install

```bash
pi install npm:pi-twitterapi.io
```

Or load a local build directly:

```bash
pi -e ./dist/index.mjs
```

## Configure

Set the twitterapi.io API key. Synthesis uses `twitter.synthesisModel` when set, and otherwise falls back to the model running the current pi session, so a key-only setup already works:

```bash
export TWITTERAPI_IO_API_KEY="your-twitterapi.io-key"
```

The settings file is strict JSON (no comments). Add the `twitter` block to
`~/.pi/agent/settings.json` — or `<cwd>/.pi/settings.json` for a project-scoped
override — and set only the keys you need:

```json
{
  "twitter": {
    "synthesisModel": "anthropic/claude-haiku-4-5-20251001",
    "enableImageUnderstanding": false,
    "enableVideoUnderstanding": false,
    "maxMediaPerSearch": 4,
    "maxPages": 5,
    "maxPagesCeiling": 20,
    "minRequestIntervalMs": 5000,
    "retryBaseDelayMs": 5000
  }
}
```

| Key | Required | Meaning |
|---|---|---|
| `synthesisModel` | no | A pi model id (`provider/model`) used to turn retrieved posts into an answer. When unset, the model running the current pi session is used as a fallback. |
| `enableImageUnderstanding` | no | Attach post images to the synthesis request when the model accepts image input. |
| `enableVideoUnderstanding` | no | Attach video poster frames (chat models cannot ingest video). |
| `maxMediaPerSearch` | no | Upper bound on media attachments per search (max 20, default 4). |
| `maxPages` | no | Base page budget per search (default 5). |
| `maxPagesCeiling` | no | Hard cap that `maxPages` is clamped to (default 20). |
| `minRequestIntervalMs` | no | Minimum spacing between upstream requests (default 5000). twitterapi.io allows 0.2 QPS on unpaid accounts; raise it if you are being throttled, lower it for a higher-QPS tier, or set it to 0 to disable pacing. |
| `retryBaseDelayMs` | no | Base delay for retry backoff (default 5000). |

> **Important:** `pi-twitterapi.io` requires a pi version whose
> `ModelRegistry.complete` is available (verified absent on pi 0.80.6, present on
> pi 0.99.2; the declared peer range is `>=0.99.2 <2`). Synthesis is a real model
> call, so it consumes tokens on the configured model.

## The `twitter` tool

| Parameter | Type | Notes |
|---|---|---|
| `query` | string (required) | Natural-language question. Required for every mode. |
| `mode` | `posts` \| `users` \| `thread` \| `user` \| `trends` \| `replies` \| `quotes` | Defaults to `posts`. |
| `tweet` | string | Post id or X permalink. Required for `thread`, `replies`, `quotes`; refused in any other mode. |
| `user` | string | Handle (no `@`) for `mode=user` (account timeline). |
| `userId` | string | Numeric user id for `mode=user`; preferred over `user` when known. |
| `woeid` | number | `mode=trends` location id (1=Worldwide, 23424977=USA). |
| `includeReplies` | boolean | `mode=user` (timeline) and `mode=quotes`. |
| `sinceTime` / `untilTime` | number | `mode=quotes`: unix timestamps (seconds) bounding the quotes. |
| `limit` | number | `mode=user`/`replies`/`quotes`: stop after this many posts (max 1000). |
| `replySort` | `"Relevance"` \| `"Latest"` \| `"Likes"` | `mode=replies` sort order (default `Relevance`). |
| `allowed_x_handles` | string[] | `mode=posts`: only these handles (max 20, no `@`). |
| `excluded_x_handles` | string[] | `mode=posts`: exclude these handles (max 20, no `@`). |
| `from_date` / `to_date` | `YYYY-MM-DD` | `mode=posts` date range. |
| `queryType` | `"Latest"` \| `"Top"` | `mode=posts`: newest-first (default) or ranked. |
| `count` | number | `mode=posts`/`users`: max items (posts default 10, accounts default 20; max 50). `mode=trends`: number of trends (min 30). |

Parameters that cannot apply in a given mode are rejected with an error rather
than silently ignored.

### Modes

| Mode | Endpoint | What it reads |
|---|---|---|
| `posts` (default) | `/twitter/tweet/advanced_search` | Keyword/operator post search; handle filters, dates, `Latest`/`Top`, item count. Optionally attaches media. |
| `users` | `/twitter/user/search` | Account discovery; profile URLs as sources. |
| `thread` | `/twitter/tweet/thread_context` | A referenced post's whole thread context. |
| `user` | `/twitter/user/last_tweets` | A specific account's most recent posts (`user`/`userId`, `includeReplies`, `limit`). |
| `trends` | `/twitter/trends` | Trending topics for a `woeid`; sources are X search URLs. |
| `replies` | `/twitter/tweet/replies/v2` | Replies to a post (`replySort`, `limit`). |
| `quotes` | `/twitter/tweet/quotes` | Quote-posts of a post (`sinceTime`/`untilTime`, `includeReplies`, `limit`). |

## Behavior and disclosures

- **Citations are derived from fetched permalinks, never from model output.**
  An X/Twitter link the model invents that was not among the retrieved posts is
  dropped from `Sources` and counted in the `## Notes` section. Non-X links are
  outside the citation contract: they are neither published as sources nor
  counted as invented citations.
- **Media is best-effort.** Video cannot be sent to a chat model, so video posts
  are represented by their poster frame and this limitation is disclosed.
- **Partial retrieval is disclosed.** If paging stops early (page cap, cursor
  cycle, or a missing cursor while more results remain), the answer carries a
  note saying the results may be incomplete.
- **Date windows are resolved at 04:00 UTC by twitterapi.io**, so posts outside
  the requested local window are trimmed while paging, with a note when that
  happens.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
