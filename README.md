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
override — and set only the keys you need. Both files are read at the start of
**every tool call**, using that call's `ctx.cwd` for the project. Edits apply to
the next call without `/reload`; in-flight calls keep their own configuration
snapshot. Project overrides still cannot supply user-only sensitive keys.

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
| `enableImageUnderstanding` | no | Attach post images when the model accepts images **and** has explicit `imageInputBounds` and reserved input space. |
| `enableVideoUnderstanding` | no | Attach video poster frames (pi's synthesis interface takes images, not video). |
| `maxMediaPerSearch` | no | Upper bound on media attachments per search (max 20, default 4); complete-input limits can reduce delivery. |
| `maxSynthesisChars` | no | Full rendered system/evidence/manifest character backstop (default 60,000, range 1,000–120,000). Separate context/output checks still apply. |
| `imageInputBounds` | no | User-only exact `provider/model` declarations: positive integer `tokensPerImage`, `maxWidth`, `maxHeight`, `maxImages`; optional raw `maxBytes` (default 10 MiB). Missing bounds omit images with disclosure; no provider accounting is guessed. |
| `maxPages` | no | Base page budget per search (default 5). |
| `maxPagesCeiling` | no | Hard cap that `maxPages` is clamped to (default 20). |
| `minRequestIntervalMs` | no | Minimum spacing between actual twitterapi.io dispatches (default 5000), shared per credential across concurrent endpoints, pagination and retries in this process. Raise it when throttled; lower it for a higher-QPS tier. Zero cannot bypass another active caller's interval or the previous dispatch's cooldown. |
| `retryBaseDelayMs` | no | Base delay for retry backoff (default 5000). Retries honor both backoff/`Retry-After` and shared request spacing; zero backoff does not bypass pacing. |
| `enableVideoProcessing` | no | Run **real** video processing (native video and/or frames + transcript). Requires `enableVideoUnderstanding`. Off by default. |
| `videoEndpointType` | no | Native-video wire format: `gemini-files` (default, Google) or `openai-compatible` (video-capable chat-completions endpoints that accept this `video_url` shape; verified with OpenRouter). An unrecognised string disables native video — frames and STT still run — and is reported in the answer rather than silently changing provider. |
| `videoEndpoint` / `videoModel` / `videoApiKeyEnv` | no | Native-video endpoint, model, and the **env var name** holding the key (default `GOOGLE_API_KEY`). `gemini-files` targets Google unless `videoEndpoint` is set. |
| `sttEndpoint` / `sttModel` / `sttApiKeyEnv` | no | OpenAI-compatible speech-to-text endpoint, model, and key env var (default `STT_API_KEY`). No hidden default provider. |
| `sttLanguage` | no | ISO-639-1 language for STT, or `auto` (default). |
| `ffmpegPath` | no | ffmpeg binary override; otherwise `ffmpeg` is searched on `PATH`. ffmpeg must be installed locally (no bundled binary) — download it from [ffmpeg.org](https://ffmpeg.org/) or your package manager. |
| `whisperCppBinary` / `whisperModelPath` | no | Local whisper.cpp binary and GGML model (both user-installed) — see [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) for builds and model downloads. |
| `whisperThreads` | no | Threads for whisper.cpp (`-t`); default `min(8, availableParallelism())`. |
| `whisperRealtimeFactor` | no | Seconds of wall clock assumed per second of audio when deciding whether local transcription fits the budget; default `2`. |
| `whisperVadModelPath` | no | Optional whisper.cpp VAD model; when set, whisper.cpp runs with `--vad`, which trims silence before decoding. |
| `maxVideoSeconds` / `maxVideoBytes` / `maxFrames` / `maxVideosPerSearch` / `videoBudgetMs` | no | Video bounds: duration guard (120), download cap (32 MiB), frames per video (8), videos per search (1), time budget (180 s, max 300 s). |

> **Video processing is opt-in and local-tooling first.** It needs
> `enableVideoUnderstanding: true` **and** `enableVideoProcessing: true`, plus a
> locally installed `ffmpeg` (for frames/audio) and optionally whisper.cpp, or a
> configured native-video / STT endpoint. Native video works two ways:
> `gemini-files` (Google, direct) and `openai-compatible` (OpenRouter and other
> chat-completions endpoints, verified with `google/gemini-2.5-flash-lite`);
> frames are sent to your pi model. A model that does not accept video input simply
> refuses the request, and the refusal is disclosed; the run then falls back to
> frames (when your pi model accepts images) and to STT (when an endpoint is
> configured), with whatever it could not use also disclosed. Check the model's
> declared input modalities before choosing one.
> Sending video/audio to a third-party endpoint is disclosed in the answer.
> Both native adapters ask for the same JSON contract, by different means:
> `gemini-files` constrains it with a response schema (`responseMimeType:
> application/json`), while `openai-compatible` can only request it in the prompt
> text, so the model names the visual/transcript sections itself in either case. A
> reply that ignores the contract is kept whole as visual evidence: the transcript
> is never inferred from prose (an invented transcript would be published as
> evidence), and STT still recovers the real speech when it is configured. A reply
> cut off at the token limit is *not* used as evidence, because half-written JSON
> would otherwise be published as a description.
> Variants are chosen from a real `HEAD` request rather than the advertised
> bitrate, which overstates the file by roughly 3x (a nominal 2176 kbps clip
> measured 6.16 MB where the bitrate suggests 19.6 MB).
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
> single video call can take several minutes. The defaults are a minimum request
> spacing of 5 s, a 60 s media phase, up to `videoBudgetMs` of video work (180 s,
> capped at 300 s), a 15 s window reserved for the poster-frame fallback, and then
> synthesis with its own retries; a Gemini Files upload is deleted before that
> fallback is used. These are budgets rather than a strict additive timeline — each
> phase spends only what it needs, and the poster window is a shared deadline, not
> a guaranteed extra wait. Provider video analysis is the slow part and its latency
> varies: measured live on 2026-10-05, one call over a 65 s clip took 33 s once and
> ~71 s another time, so expect a long tool call on a media-heavy query. Local
> transcription is bound by your hardware instead: the same day, `whisper.cpp` with
> `large-v3-turbo` **on CPU** took about **3 minutes** to transcribe a 30 s clip.
> CPU inference does work and needs nothing special, but it is **slow**, and a large
> model can cost far more wall-clock time than the clip is long.
>
> **Accelerated builds are strongly recommended for local processing.** whisper.cpp
> ships backends for Apple Silicon (Metal, Core ML and the Accelerate framework),
> NVIDIA GPUs (CUDA), AMD GPUs (ROCm), Vulkan GPUs, OpenVINO, and NPUs including AMD
> Ryzen AI and Ascend — with a per-backend list of verified devices in the
> [whisper.cpp README](https://github.com/ggml-org/whisper.cpp). Pick a build for your
> hardware and a model size that keeps up on your machine before enabling the local
> tier. `whisperThreads` (default `min(8, availableParallelism())`) is passed to
> whisper.cpp as `-t`, and it matters: on one CPU-only host the same 30 s clip took
> **61 s on 4 threads and 42 s on 12**. A smaller model (`base`, `small`) is usually
> the bigger win on a CPU-only machine.
>
> **Local transcription is skipped when it cannot fit.** Before starting whisper.cpp
> the extension compares the remaining video budget with
> `clipSeconds × whisperRealtimeFactor` (default `2`, i.e. two seconds of wall clock
> per second of audio) and skips with a note rather than burning the whole budget and
> being killed late. On a CPU-only host, either use a smaller model, set
> `whisperRealtimeFactor` to match your machine, or use the remote `sttEndpoint`
> instead — a remote endpoint costs a request, local transcription costs your
> hardware's time.
>
> Neither tool is bundled: install `ffmpeg` from [ffmpeg.org](https://ffmpeg.org/)
> (or your package manager) and `whisper.cpp` from
> [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp), then point
> `ffmpegPath` and `whisperCppBinary` at the binaries you installed.
>
> **Cost.** Native video is billed by whichever endpoint you configure, and video is
> tokenised by **duration** rather than file size. In one measurement on
> 2026-10-05, `google/gemini-2.5-flash-lite` counted 258 video tokens per second of
> clip (about 31k tokens for the default 120 s window) and a single 120 s analysis
> cost **$0.0031** at OpenRouter list prices; the same clip cost **$0.0045** on
> `qwen/qwen3.7-flash`, whose completion spent most of its tokens on reasoning. Treat
> those as one model's rates, not a rule for every provider, and re-check the
> current prices — they change.
>
> They are single-call examples, not per-search totals and not a cap. Retrieval,
> the synthesis model's text/image/output tokens, optional STT, and any retries or
> fallbacks all add up on top, and work that is thrown away may still be billed: a
> native reply cut off at its token limit is refused, and a timed-out attempt is
> abandoned, but only after the provider has processed the clip. Only the trimmed
> `maxVideoSeconds` window is ever sent, and `maxVideosPerSearch` (default 1) bounds
> how many videos one search will analyse. The other tiers bill separately: frames
> ride your pi model as images at normal token cost, a configured STT endpoint
> charges in **its own provider's units, rates and minimums** (per second of audio
> for most hosted Whisper APIs, with the audio re-sent — up to three attempts — when
> an endpoint rejects the requested response format), and local `ffmpeg` plus
> whisper.cpp cost nothing beyond the model files you download.

For native video through OpenRouter instead of Google:

```json
{
  "twitter": {
    "enableVideoUnderstanding": true,
    "enableVideoProcessing": true,
    "videoEndpointType": "openai-compatible",
    "videoEndpoint": "https://openrouter.ai/api/v1",
    "videoApiKeyEnv": "OPENROUTER_API_KEY",
    "videoModel": "google/gemini-2.5-flash-lite"
  }
}
```

> **Important:** the extension needs a pi version whose `ModelRegistry.complete`
> exists — it is absent on pi 0.80.6, present from pi 0.99.2, and verified on
> pi 1.0.2. `@earendil-works/pi-coding-agent` is declared as a peer with a
> `^1.0.0` range, so a package manager that resolves peers will refuse anything
> older than **1.0.0, the supported minimum** — not the first release with that
> method, which is 0.99.2; 1.0.0 is simply the line this extension is tested
> against. `pi-tui` and `typebox` stay at `"*"` because pi supplies them at
> runtime. Synthesis is a real model call, so it consumes tokens on the configured
> model.

### Complete-input budget

Before retrieval, the primary and fallback catalogue entries must expose valid
`contextWindow` and `maxTokens`. A question that cannot fit the system/scaffold is
rejected before an API read. All four synthesis paths budget their **rendered**
input; text uses UTF-8 bytes as a conservative token estimate plus 1,024 tokens of
message overhead. This is not an exact provider tokenizer or serialized-envelope
guarantee. Output is explicitly reserved and passed to every physical completion,
including retries/repair: at most 4,096 tokens, reduced by model output caps and
one quarter of the smallest context window.

Whole post/account/trend bundles or document fields are selected locally. Before
media work, bounded transcript/visual evidence, image slots, references and the
manifest are reserved. JSON escape worst cases for controls/lone surrogates are
reserved separately when catalogue request-byte limits exist; already image-free
questions are measured verbatim, not pattern-stripped. Omitted post bundles and
unreserved video assets incur no
media/video/STT call. Final input is checked again. Local omissions are disclosed
separately from upstream paging limits; existing 700-character post/bio caps stay
in place. Inline Sources come only from delivered evidence. The deduplicated
no-inline fallback lists at most 20 Sources and discloses that cap.

**Images now need an explicit declaration.** Put `imageInputBounds` in **user**
settings, never project settings, keyed by the exact answering `provider/model`.
For example, this declares an *assumed* 8,192-token upper bound for images within
these dimensions; verify that assumption for your actual model/provider before
using it (it is not a measured universal default):

```json
{
  "twitter": {
    "imageInputBounds": {
      "your-provider/your-model": {
        "tokensPerImage": 8192,
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxImages": 4,
        "maxBytes": 5242880
      }
    }
  }
}
```

Dimensions are clamped to 8,192, count to 100 and raw bytes to 10 MiB; token upper
bounds are never clamped downward. Catalogue image-count/resize limits also apply.
Only static PNG/JPEG byte headers with known dimensions are admitted; animated or
unknown encodings, oversized dimensions/bytes and unreserved slots are omitted.
This validates bounded geometry, not full image decoding. No automatic resizing
or model-family formula is invented. Incorrect declarations can still cause
provider rejection. Native-video/STT text evidence remains eligible without image
bounds. Text-only or undeclared-image fallbacks retain the same selected sources
and trusted question, but omit images, their manifest and attachment references.

### Shared request pacing

Dispatches use a per-credential FIFO, not sequential tool execution. The largest
interval among active HTTP calls (including response reads and retry backoff)
and the previous dispatch's interval set the next minimum gap. Time is rechecked
on wake, so late timers cannot release a burst. Response reads and synthesis can
still overlap; cancellation abandons queued/sleeping calls without dispatching.
Idle credential digests expire after their cooldown. This process-local limiter
never paces media/STT/model hosts; other Pi processes using the same key still
need their own coordination.

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
- **Quoted/reposted context keeps its original attribution.** One nested level
  is retained, with reply target, language and quote-count metadata. Id-only stubs
  are ignored; media-only sources survive. Longer original text replaces a
  truncated RT copy under the existing text caps, without changing the enclosing
  post's identity. Valid fetched nested permalinks can be cited. Own, quoted and
  reposted media share the existing caps and phase deadlines (photos still come
  first). Repeated assets are downloaded/processed once, including mirrored RT
  media; exact numeric media IDs recognize endpoint-specific CDN query aliases
  only when media kind, file locations and duration bounds agree. Exact URL
  matches still deduplicate when an ID is absent from one envelope. Actual
  download URLs are unchanged; without an ID, different query URLs remain distinct. A common poster
  does not imply common audio. Ordered image references
  and quoted/reposted speech remain tied to their fetched original and enclosing
  post. Missing/invalid permalinks are not guessed; anonymous media bindings use
  object identity, so they cannot be transferred to unrelated candidates.
- **Links and previews are metadata, not fetched pages.** Matching t.co tokens
  expand from validated entity destinations without visiting them. Cards (including
  by-id `card.legacy`), accessibility alt text and article title/preview/cover URLs
  retain their own or quoted/reposted source attribution and prompt guards.
  Mirrored wrapper alt text is suppressed under the fetched original's ownership,
  even with media understanding disabled; captions are not transplanted.
  An article preview is not its full body; alt text is not visual analysis. These
  destinations never join `Sources`. The existing 700-character post/bio caps
  remain until complete-input budgeting is implemented.
- **Profile/pin metadata is explicit.** Available author/profile counts and
  website destinations are included. Profile pin IDs do not imply their content
  was fetched. A full pin supplied by the timeline is marked and deduplicated;
  IDs/stubs/unknown pin shapes do not trigger another paid lookup, and missing
  content is disclosed. Non-null timeline-pin handling currently has synthetic
  coverage only; the live inventory returned null pins.
- **Media is best-effort.** By default a video post is represented by its poster
  frame and the limitation is disclosed, because pi's synthesis interface cannot
  ingest video. With `enableVideoProcessing` (see above) the video itself is analysed —
  locally trimmed frames/audio, and/or the configured native-video or STT
  endpoint — and the poster is kept only as the fallback when that yields nothing.
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
- **Images and the fallback.** Attachments require image support, explicit
  per-model bounds, valid bounded geometry and input space. Unknown bounds omit
  images, not native-video/STT text. Text-only or undeclared-image fallbacks also
  omit manifests/references, with disclosure. See the complete-input budget above.
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
| Video understanding | ✅ `enable_video_understanding` | ⚠️ poster frame by default; opt-in `enableVideoProcessing` adds native video (`gemini-files` or an `openai-compatible` endpoint) and/or frames + STT |
| Answer generation | Grok (xAI) | any pi model: `twitter.synthesisModel`, else the session model |
| Citations | xAI annotations/citations | derived from fetched permalinks; unmatched X links dropped and disclosed |
| Cost | xAI tokens + per post/profile | twitterapi.io credits + your model's tokens; opt-in video and STT add endpoint charges — [cost comparison](docs/pricing-comparison.md) |
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
