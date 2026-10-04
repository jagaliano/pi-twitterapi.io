# pi-twitterapi.io

A [twitterapi.io](https://twitterapi.io)-backed X/Twitter extension for the
[pi coding agent](https://pi.dev). It registers a `twitter` tool that reads
posts, accounts, threads, timelines, trends, conversations and more through
twitterapi.io, then synthesizes an answer with citation URLs using a model from
pi's own registry.

This extension is self-contained: twitterapi.io is the only retrieval source and
pi's model registry performs the synthesis. It is designed to cover the same
surface as xAI's official `x_search` tool and, where twitterapi.io exposes more,
to go beyond it — see [Compared with xAI `x_search`](#compared-with-xai-x_search).

## Install

```bash
pi install npm:pi-twitterapi.io
```

Or load the local source directly (pi compiles TypeScript extensions on the
fly, so there is no build step):

```bash
pi -e ./src/index.ts
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
| `synthesisModel` | no | A pi model id (`provider/model`) used to turn retrieved posts into an answer. When unset, the session model is used; if it is set but fails at runtime, the session model answers instead with a note. |
| `enableImageUnderstanding` | no | Attach post images to the synthesis request when the model accepts image input. |
| `enableVideoUnderstanding` | no | Attach video poster frames (chat models cannot ingest video). |
| `maxMediaPerSearch` | no | Upper bound on media attachments per search (max 20, default 4). |
| `maxPages` | no | Base page budget per search (default 5). |
| `maxPagesCeiling` | no | Hard cap that `maxPages` is clamped to (default 20). |
| `minRequestIntervalMs` | no | Minimum spacing between upstream requests (default 5000). twitterapi.io allows 0.2 QPS on unpaid accounts; raise it if you are being throttled, lower it for a higher-QPS tier, or set it to 0 to disable pacing. |
| `retryBaseDelayMs` | no | Base delay for retry backoff (default 5000). |
| `enableVideoProcessing` | no | Run **real** video processing (native video and/or frames + transcript). Requires `enableVideoUnderstanding`. Off by default. |
| `videoEndpointType` | no | Native-video wire format: `gemini-files` (default) or `openai-compatible` (unverified). |
| `videoEndpoint` / `videoModel` / `videoApiKeyEnv` | no | Native-video endpoint, model, and the **env var name** holding the key (default `GOOGLE_API_KEY`). `gemini-files` targets Google unless `videoEndpoint` is set. |
| `sttEndpoint` / `sttModel` / `sttApiKeyEnv` | no | OpenAI-compatible speech-to-text endpoint, model, and key env var (default `STT_API_KEY`). No hidden default provider. |
| `sttLanguage` | no | ISO-639-1 language for STT, or `auto` (default). |
| `ffmpegPath` | no | ffmpeg binary override; otherwise `ffmpeg` is searched on `PATH`. ffmpeg must be installed locally (no bundled binary). |
| `whisperCppBinary` / `whisperModelPath` | no | Local whisper.cpp binary and GGML model (both user-installed). |
| `maxVideoSeconds` / `maxVideoBytes` / `maxFrames` / `maxVideosPerSearch` / `videoBudgetMs` | no | Video bounds: duration guard (120), download cap (32 MiB), frames per video (8), videos per search (1), time budget (90 s). |

> **Video processing is opt-in and local-tooling first.** It needs
> `enableVideoUnderstanding: true` **and** `enableVideoProcessing: true`, plus a
> locally installed `ffmpeg` (for frames/audio) and optionally whisper.cpp, or a
> configured native-video / STT endpoint. In v1 native video goes to **Gemini
> only** (`gemini-files`); frames are sent to your pi model; `openai-compatible`
> video is **not** enabled pending verification (Grok cannot take video input at
> all). Sending video/audio to a third-party endpoint is disclosed in the answer.
> Executable paths, endpoints and credential names are read from **user
> settings only** — project `.pi/settings.json` values for those keys are
> ignored and disclosed. A custom `videoEndpoint` is only honoured when
> `videoApiKeyEnv` is set explicitly (and must be `https://`), so the default
> key is never sent to another host.
>
> **Retention and duration.** When native video uses the Gemini Files API the
> upload is deleted on a **best-effort** basis once the call finishes, with its
> own short timeout so a cancelled request cannot skip it. If deletion fails — or
> an upload happened but generation failed, returned nothing, or was cancelled —
> the answer says the file may be retained. Google's Files API keeps undeleted
> uploads for roughly **48 hours**, so treat such a file as readable by that
> project for about that long. Only the first `maxVideoSeconds` (default 120 s)
> are analysed: the video is trimmed locally when possible, and a clip that
> **cannot** be trimmed is not uploaded whole — the native path is skipped and
> disclosed, while frames and audio stay limited to that window. Worst case a
> single video call can take roughly **six minutes** (retrieval pacing + 60 s
> media phase + up to 120 s video phase + synthesis), so expect a long tool call
> on a media-heavy query.

> **Important:** the extension needs a pi version whose `ModelRegistry.complete`
> exists — it is absent on pi 0.80.6, present from pi 0.99.2, and verified on
> pi 1.0.2. The host packages are declared as peers with a `"*"` range because pi
> supplies them at runtime, so that range does not enforce the capability: check
> your pi version if you are on an old release. Synthesis is a real model call, so
> it consumes tokens on the configured model.

## The `twitter` tool

| Parameter | Type | Notes |
|---|---|---|
| `query` | string (required) | Natural-language question. Required for every mode. |
| `mode` | `posts` \| `users` \| `thread` \| `user` \| `trends` \| `replies` \| `quotes` \| `mentions` \| `followers` \| `followings` \| `profile` \| `about` \| `tweets` \| `retweeters` \| `community` \| `list` \| `space` | Defaults to `posts`. |
| `tweet` | string | Post id or X permalink. Required for `thread`, `replies`, `quotes`, `retweeters`; refused in any other mode. |
| `user` | string | Handle (no `@`) for `mode=user`, `mentions`, `followers`, `followings`, `profile`, `about`. |
| `userId` | string | Numeric user id for `mode=user`; preferred over `user` when known. |
| `ids` | string[] | `mode=tweets`: post ids or permalinks to fetch (max 100). |
| `pageSize` | number | `mode=followers`/`followings`: accounts per page (20–200). |
| `communityId` | string | `mode=community`: the community id. |
| `listId` | string | `mode=list`: the list id. |
| `spaceId` | string | `mode=space`: the X Space id. |
| `woeid` | number | `mode=trends` location id (1=Worldwide, 23424977=USA). |
| `includeReplies` | boolean | `mode=user` (timeline) and `mode=quotes`. |
| `sinceTime` / `untilTime` | number | `mode=quotes` and `mode=mentions`: unix timestamps (seconds) bounding the results. |
| `limit` | number | `mode=user`/`mentions`/`followers`/`followings`/`replies`/`quotes`/`retweeters`/`community`/`list`: stop after this many items (max 1000). |
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
| `mentions` | `/twitter/user/mentions` | Posts mentioning an account (`user`, `sinceTime`/`untilTime`, `limit`). |
| `followers` | `/twitter/user/followers` | Who follows an account (`user`, `pageSize`, `limit`); profile URLs as sources. |
| `followings` | `/twitter/user/followings` | Who an account follows (`user`, `pageSize`, `limit`). |
| `profile` | `/twitter/user/info` | A single account profile (`user`). |
| `about` | `/twitter/user_about` | Extended profile-page metadata (`user`): account-based-in, creation source, handle changes, identity verification; cited as the profile URL. |
| `tweets` | `/twitter/tweets` | Specific posts by id (`ids`, max 100). |
| `retweeters` | `/twitter/tweet/retweeters` | Accounts that reposted a post (`tweet`, `limit`); profile URLs as sources. |
| `community` | `/twitter/community/tweets` | Posts from a community (`communityId`, `limit`). |
| `list` | `/twitter/list/tweets_timeline` | Posts from a list (`listId`, `limit`). |
| `space` | `/twitter/spaces/detail` | An X Space's detail (`spaceId`); cited as `https://x.com/i/spaces/<id>`. Note: twitterapi.io currently returns HTTP 404 for this endpoint even for Spaces that are live in the X app, so the mode often reports the upstream error verbatim. |

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
- **`mode=space` depends on a flaky upstream.** twitterapi.io's
  `/twitter/spaces/detail` returned HTTP 404 "Space not found or API error" for
  a Space that X itself displayed as live, so this mode frequently reports the
  upstream error rather than a summary.
- **Date windows are resolved at 04:00 UTC by twitterapi.io**, so posts outside
  the requested local window are trimmed while paging, with a note when that
  happens. Two consequences worth knowing: far-west offsets (for example
  UTC-8/-10) can lose the last few hours of the requested day because the
  upstream window ends before local midnight (disclosed as a note), and far-east
  offsets (UTC+10 and beyond) can spend free paging on the newer trim band before
  results begin. Start padding is deliberately conservative (one extra hour) so a
  winter boundary shift cannot silently drop the first hour of the local day.
- **Images and the fallback.** Media is attached only when the model chosen to
  synthesize accepts image input; if that model fails and a different model
  answers, images are omitted rather than sent to a model that cannot read them,
  and the answer says so.
- **Synthesis fallback.** If `twitter.synthesisModel` fails at runtime, the
  answer is retried with the model running the current session and the result
  carries a note naming the model that answered. Failures are classified so the
  chain reacts per kind rather than treating every error alike:

  | Failure | Examples | Reaction |
  |---|---|---|
  | Quota / billing | `402`, `insufficient_quota`, quota exceeded, subscription limit | next model |
  | Authentication | `401`, `403`, invalid API key | next model |
  | Unknown model | `404`, "does not exist" | next model |
  | Invalid request | `400`, `422`, malformed | next model |
  | Rate limit | `429`, "too many requests", overloaded | next model, retried once when it is the last one |
  | Server | `5xx`, bad gateway, unavailable | next model, retried once when it is the last one |
  | Transport | timeouts, connection drops, premature stream endings | next model, retried once when it is the last one |
  | Empty response | model returned no usable text | next model, retried once when it is the last one |
  | Unclassified | anything else | next model, never retried |
  | Cancelled | aborted signal / `AbortError`, or pi's "was cancelled" wording | stop, no fallback |

  Deterministic failures never retry the same model. The bounded retry (500 ms,
  doubling to a 4 s cap) is spent only on the last available model, since an
  untried model is the better bet while one remains.

## Compared with xAI `x_search`

xAI's official [`x_search`](https://docs.x.ai/developers/tools/x-search) is a
server-side tool that bundles four underlying operations — keyword search,
semantic search, user search and thread fetch — and lets Grok choose which to
run. `pi-twitterapi.io` targets the same read surface through twitterapi.io's REST
API and adds the endpoints twitterapi.io exposes that `x_search` has no
equivalent for. The table below is the honest capability comparison; the full
version, including parameter mapping, lives in
[`docs/x-search-comparison.md`](docs/x-search-comparison.md).

| Capability | xAI `x_search` | `pi-twitterapi.io` (`twitter` tool) |
|---|---|---|
| Retrieval source | xAI's server-side X index | twitterapi.io REST API |
| Credential | `XAI_API_KEY` | `TWITTERAPI_IO_API_KEY` |
| Keyword post search | ✅ `x_keyword_search` | ✅ `mode=posts` (`advanced_search`) |
| Semantic search | ✅ `x_semantic_search` | ❌ **no equivalent** (twitterapi.io has no semantic endpoint) |
| User/account search | ✅ `x_user_search` | ✅ `mode=users` |
| Thread fetch | ✅ `x_thread_fetch` | ✅ `mode=thread` |
| Account timeline | ❌ | ✅ `mode=user` (`last_tweets`) |
| Trends by location | ❌ | ✅ `mode=trends` |
| Replies to a post | ❌ | ✅ `mode=replies` |
| Quote-posts | ❌ | ✅ `mode=quotes` |
| Mentions of an account | ❌ | ✅ `mode=mentions` |
| Followers / followings | ❌ | ✅ `mode=followers`, `mode=followings` |
| Single profile lookup | partial (via user search) | ✅ `mode=profile` |
| Extended profile ("about") metadata | ❌ | ✅ `mode=about` |
| Fetch posts by id | ❌ | ✅ `mode=tweets` |
| Users who reposted a post | ❌ | ✅ `mode=retweeters` |
| Communities / lists / Spaces | ❌ | ✅ `mode=community`, `mode=list`, `mode=space` |
| Handle filters | `allowed_x_handles` / `excluded_x_handles` (max 20, mutually exclusive) | same, `mode=posts` |
| Date range | `from_date` / `to_date` (`YYYY-MM-DD`) | same, `mode=posts`; plus unix windows for `quotes`/`mentions` |
| Result order | chosen by the model | `queryType` (`Latest`/`Top`), `replySort` |
| Item-count control | ❌ | ✅ `count`, `limit` |
| Image understanding | ✅ `enable_image_understanding` | ✅ `enableImageUnderstanding` (attached when the model accepts images) |
| Video understanding | ✅ `enable_video_understanding` | ⚠️ poster frame only (chat models cannot ingest video) |
| Answer generation | Grok (xAI) | any pi model: `twitter.synthesisModel`, else the session model |
| Citations | xAI annotations/citations | derived from fetched permalinks; unmatched X links dropped and disclosed |
| Cost | xAI tokens + per post/profile | twitterapi.io credits + your model's tokens — [cost comparison](docs/pricing-comparison.md) |
| Shape | one `x_search` request | one `twitter` tool with 17 modes |

Per-item costs differ by more than an order of magnitude, and the two routes
meter different things: [a dated, sourced cost comparison](docs/pricing-comparison.md)
covers the unit prices, the counting rules that change the bill, cost per mode,
and how to add the answer model's tokens.

**Summary.** `pi-twitterapi.io` matches `x_search` on keyword search, user search,
thread fetch, handle filters, date ranges and image understanding, and adds a
dedicated account timeline, trends, replies, quotes, mentions, followers,
followings, profile, about, posts-by-id, retweeters, community, list and Space
modes. The one
capability it cannot match is **semantic search**, because twitterapi.io exposes
only keyword/operator search. It also differs structurally: `x_search` is one
server-side call answered by Grok, while this extension retrieves through
twitterapi.io and synthesizes with a pi model of your choice.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

There is no build step. Pi loads the TypeScript sources in `src/` directly
through [jiti](https://github.com/unjs/jiti), and the published package ships
those sources, so `pi install npm:pi-twitterapi.io` and
`pi install git:github.com/jagaliano/pi-twitterapi.io` both work without a
compile step. `src/*.test.ts` files are excluded from the npm tarball.

The dev dependencies are version ranges (pi 1.0.2, typebox 1.3.x) resolved by
[`pnpm-lock.yaml`](pnpm-lock.yaml); CI installs them with `--frozen-lockfile`,
so a build is reproducible from the lockfile rather than from the manifest.

## Releases

1. `pnpm typecheck && pnpm test`
2. Update [`CHANGELOG.md`](CHANGELOG.md), then bump the version with
   `npm version patch` (or `minor`), which also creates the git tag
3. `git push origin main --tags` — a `v*` tag makes `.github/workflows/release.yml`
   publish it (needs an `NPM_TOKEN` repository secret) and open the GitHub release
4. Or publish by hand: `npm publish --access public`

### Rehearsing a release

The pipeline can be checked without releasing anything. It runs the tag/version
check, install, typecheck, tests and a token check, then stops unless the publish
is explicitly requested:

```bash
gh workflow run verify-npm-token.yml --repo jagaliano/pi-twitterapi.io
gh workflow run release.yml --ref vX.Y.Z                  # dry run
gh workflow run release.yml --ref vX.Y.Z -f publish=true  # the real publish
```

`workflow_dispatch` runs the workflow as it exists at the given ref, so a manual
run has to target a tag that already contains the revision you want. The `v0.1.0`
tag was created before the dry-run mode existed, so dispatching against it
publishes directly.

Once the package exists on npm you can switch to
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) and delete
`NPM_TOKEN`; the workflow works with either.

The `pi-package` keyword makes the published package eligible for the
[pi package gallery](https://pi.dev/packages); the gallery indexes npm, so there
is nothing to submit separately. `.github/workflows/ci.yml` typechecks and tests
every push and pull request.

## License

MIT
