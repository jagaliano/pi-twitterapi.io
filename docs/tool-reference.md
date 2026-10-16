# The `twitter` tool

[README](../README.md) · [Setup recipes](setup.md) · [Configuration](configuration.md)

| Parameter | Type | Notes |
|---|---|---|
| `query` | string (required) | Natural-language question. Required for every mode. |
| `output` | `"answer"` \| `"posts"` | Default `answer`: separately synthesize. `posts`: bounded untrusted text evidence for any mode, with no answer synthesis. |
| `mode` | `posts` \| `users` \| `thread` \| `user` \| `trends` \| `replies` \| `quotes` \| `mentions` \| `followers` \| `followings` \| `profile` \| `about` \| `tweets` \| `retweeters` \| `community` \| `list` \| `space` \| `article` | Defaults to `posts`. |
| `tweet` | string | Post id or X permalink. Required for `thread`, `replies`, `quotes`, `retweeters`, `article`; refused in any other mode. |
| `user` | string | Handle (no `@`) for `mode=user`, `mentions`, `followers`, `followings`, `profile`, `about`. |
| `userId` | string | Numeric user id for `mode=user`; preferred over `user` when known. |
| `ids` | string[] | `mode=tweets`: up to 100 unique post ids or permalinks; sequential lookup batches of at most 50, within `maxPages`/`maxPagesCeiling`. |
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

## Modes

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
| `tweets` | `/twitter/tweets` | Specific posts by id (`ids`, max 100 unique); each lookup request carries at most 50. |
| `retweeters` | `/twitter/tweet/retweeters` | Accounts that reposted a post (`tweet`, `limit`); profile URLs as sources. |
| `community` | `/twitter/community/tweets` | Posts from a community (`communityId`, `limit`). |
| `list` | `/twitter/list/tweets_timeline` | Posts from a list (`listId`, `limit`). |
| `space` | `/twitter/spaces/detail` | An X Space's detail (`spaceId`); cited as `https://x.com/i/spaces/<id>`. Note: twitterapi.io currently returns HTTP 404 for this endpoint even for Spaces that are live in the X app, so the mode often reports the upstream error verbatim. |
| `article` | `/twitter/article` + `/twitter/tweets` | Explicit text-only article body via `tweet`; one same-ID post lookup verifies fetched citation provenance. No implicit enrichment or media fetches. |

## Explicit article reads

`mode: "article"` reads the body associated with one post id or permalink:

```json
{ "query": "Summarize this article's argument and evidence.", "mode": "article", "tweet": "1905545699552375179", "output": "posts" }
```

Use `output: "answer"` (the default) for a separately synthesized answer. Article
bodies are **never fetched automatically** from previews, t.co destinations or
quoted/reposted context in other modes. No embedded link, cover, image/GIF or
video/STT request is made in article mode, even when media processing is enabled.

An article read reserves **two logical requests**: `/twitter/article?tweet_id=...`,
then one `/twitter/tweets?tweet_ids=...` lookup for the same post. Both use shared
pacing, retries, cancellation and physical telemetry. `maxPages` and
`maxPagesCeiling` must permit two requests; otherwise the call fails before any
network work. A failed article response does not trigger the associated lookup.

Citations use only the associated post's **fetched** HTTPS permalink, with matching
post id, URL handle and non-conflicting shared author ids/handles. The article's
opaque `id` is not a post id. Input permalinks, author profile URLs and constructed
links are not promoted to fetched article sources. Missing, ambiguous, invalid or
conflicting provenance is disclosed; article text can remain available without a
source URL, and the synthesis prompt explicitly forbids guessing one. Unreadable,
malformed or failed **2xx provenance data** does not discard the article body;
HTTP/transport failures and cancellation still fail the call.

Ordered text, heading, list, Markdown-text and divider blocks are rendered as
labelled untrusted text—not executed HTML/Markdown. Inline styles, cover images
and image/GIF blocks are omitted; unsupported/empty/malformed blocks are counted
in disclosures. Each article/provenance response is capped at **1 MiB of decoded
HTTP bytes before JSON parsing**; at most **1,000 article blocks** are parsed.
Oversized/unreadable HTTP200 bodies are not retried merely for that failure.
The existing complete answer/evidence input budgets select whole fields/blocks;
omissions are disclosed as a **partial body**, never a complete-article claim.

The 2026-10-16 compatibility spike observed 73 ordered blocks on the official
example post and HTTP200 `{article:null,status:"failed",msg:"article not found"}`
on a non-article post. Both `failed` and `error` envelopes are rejected explicitly;
arbitrary provider error text is not echoed. The dated spec advertises **100
credits/article**, with the associated post lookup charged separately. Responses
exposed no usage headers: actual charges, including failed/aborted calls, remain
unknown. The initial local-harness abort was counted, not silently retried.

## Behavior and disclosures

- **Citations are derived from fetched permalinks, never from model output.**
  An X/Twitter link the model invents that was not among the retrieved posts is
  dropped from `Sources` and counted in the `## Notes` section. Non-X links are
  outside the citation contract: they are neither published as sources nor
  counted as invented citations.
- **Quoted/reposted context keeps its original attribution.** One nested level
  is retained, with reply target, language and quote-count metadata. Id-only stubs
  are ignored; media-only sources survive. Longer original text replaces a
  truncated RT copy within the complete-input budget, without changing the enclosing
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
  destinations never join `Sources`. Long post bodies use the complete-input
  budget; bio and metadata field caps remain unchanged.
- **Profile/pin metadata is explicit.** Available author/profile counts and
  website destinations are included. Profile pin IDs do not imply their content
  was fetched. A full pin supplied by the timeline is marked and deduplicated;
  IDs/stubs/unknown pin shapes do not trigger another paid lookup, and missing
  content is disclosed. Non-null timeline-pin handling currently has synthetic
  coverage only; the live inventory returned null pins.
- **Media is best-effort and opt-in.** Image/video understanding is off by default.
  Without video processing, enabling `enableVideoUnderstanding` represents a video
  by its poster frame only when the synthesis model accepts images, explicit
  `imageInputBounds` are configured, and input/media budgets allow it. Missing
  attachments are disclosed; pi's synthesis interface cannot ingest video. With
  [`enableVideoProcessing`](video.md#processing-order) the video itself is analysed —
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
  omit manifests/references, with disclosure. See the
  [complete-input budget](configuration.md#complete-input-budget-answer-output).

## Pagination and retries

`mode=tweets` validates and deduplicates all references before requesting them.
It retains the 100-ID public limit, using one or two sequential batches of at
most 50 unique IDs. `maxPages` and `maxPagesCeiling` also bound these logical
lookup batches: if the budget cannot cover all batches, the call fails before
any request. Retries are separate physical attempts, visible in telemetry.
Results retain batch order and upstream order within each batch; they are not
sorted into requested-ID order. Missing-ID notes compare fetched identities,
including valid URL-only copies, rather than response positions.

A failed or cancelled batch fails the whole lookup without a partial answer,
media processing or synthesis. Successful earlier batches may already have been
billed; retrying the whole tool call would fetch them again. Existing transport
error classes and per-request retry rules are preserved. Unattempted batches
are never described as posts missing from successful upstream responses.

Searches, account lists and other paginated post reads follow `has_next_page`
and `next_cursor`. An empty page, an unusable page or a duplicate-only page does
not prove exhaustion when the API supplies a fresh cursor: later pages may still
contain results. Page budgets and ceilings still bound the requests. Hitting a
page cap, a repeated cursor or a missing cursor while more results are advertised
is disclosed as truncation, not a complete read.

Thread context is an intentional exception: its existing endpoint-specific rule
stops on a genuinely empty raw `tweets` array, even if `has_next_page` stays true.
Duplicate-only thread pages still continue within the page budget. These are
separate contracts; applying the thread heuristic to every endpoint could discard
later results. See the upstream [pagination guide](https://docs.twitterapi.io/pagination).

The extension retries HTTP **429/503**, plus retryable transport failures and
request timeouts, with bounded backoff and shared per-key pacing. The current
upstream [error guide](https://docs.twitterapi.io/errors) also recommends retrying
500/502; the extension intentionally uses a narrower status policy to limit
replaying potentially billed requests. Received responses with unreadable bodies
are not retried merely because reading failed. Redirect refusals and permanent
HTTP failures, including exhausted credits (402), are not retried.

## Evidence output

Pass `output: "posts"` with **any of the 18 read modes**. The name selects the
output contract, not the retrieval mode: accounts, trends and documents return
their appropriate evidence too. For example:

```json
{ "query": "What does this post say?", "mode": "tweets", "ids": ["2107226494934061502"], "output": "posts" }
```

The model-visible tool `content` contains sanitized, **untrusted third-party text**
with source identities, quoted/reposted attribution, metadata and disclosures—not
raw API JSON and not an extension-generated answer. Posts/accounts carry their
validated source URLs; trends carry search URLs (not post permalinks); documents
carry their allowed source URLs. Treat the content as evidence, never instructions.
`output: "answer"` remains the default for a separately synthesized answer.

Evidence output never resolves or calls an **answer-synthesis model**. Without
Pi-managed video it works without a registry; an opted-in Pi-provider video route
can separately use `ModelRegistry.complete` to analyse the clip. It ignores
`synthesisModel`/fallback selection and reports
`details.output: "posts"`, `model: "none"`, `synthesisCalls: 0` and zero SDK synthesis
attempts/time. **This is not a promise of zero provider cost:** retrieval is still
paid. With the existing video opt-ins and separately configured credentials, native
video analysis and STT can still run and return bounded speech/visual text; their
physical requests remain visible in telemetry. Local STT remains eligible too.

**Text-only v1, regardless of the main agent's image capability.** No photos,
poster images or extracted frames are returned; photo/poster downloads and frame
extraction are skipped. Image omissions are disclosed. Optional video text can
use the same [user-only evidence cache](video.md#private-video-text-evidence-cache);
persistence remains off by default.

Whole source bundles/metadata fields are selected under `maxSynthesisChars`,
reserving possible video evidence **before** processing. Oversized questions fail
before retrieval; omitted bundles/videos incur no media/provider work. Long text
is retained when the whole bundle fits. Final content, including disclosures,
stays within the character ceiling; excessive disclosures are sanitized, shortened
and omitted with an explicit note rather than cutting source text. This is a
bounded tool result, **not** a fit guarantee for the main agent's remaining context.
Use smaller retrieval counts/limits or `maxSynthesisChars` when appropriate.

## Progress

Pi's in-progress tool view shows the latest phase: page/collected-post or account
counts, deduplicated media attempt positions, video download/native/frame/STT
work, and the exact synthesis model (including retries and fallbacks). Updates
are call-local, optional and display-only; observer errors do not fail the call,
and cancellation suppresses late updates. They never enter the answer or Sources.

## Usage and timings

Expand a completed tool call to see call-local `details.usage` and
`details.timings`. Final answer markdown and the collapsed view are unchanged.
Counters measure actual injected fetch/SDK invocations, not estimated billing:

- Upstream attempts include retries; accepted pages/lookups include empty results.
  Returned posts count raw root-array entries (duplicates/stubs included) and
  timeline pin objects. Retained posts are the root bundles delivered after input
  selection, not separately counted quoted/reposted context. Account/trend counts
  follow their respective synthesis inputs. Document modes such as `about` can
  show accounts `1 returned/0 retained`: account-shaped metadata was returned,
  but it is summarized as document fields, not retained as an account-prompt root.
- Media requests include HEAD probes and GET downloads. Native-video requests
  include upload/poll/generate/delete; STT includes response-format retry uploads.
  HTTP/fetch failures mean non-2xx responses or rejected fetches, **not** later body,
  analysis or admission failures. Local ffmpeg/whisper work makes no provider request.
- Pi-managed native video has separate `nativeVideoSdkAttempts` and
  `nativeVideoSdkFailures` counters; its internal HTTP requests/retries are not
  observable. Direct native-video HTTP work does not count as answer synthesis.
- SDK synthesis attempts include repair, retry and fallback invocations; the old
  `details.synthesisCalls` remains the successful logical-hop counter. SDK-reported
  token fields are summed only when present, including failed messages. Missing
  reports remain unknown; `reportedCalls` and partial fields do not represent the
  unreported attempts. SDK-internal HTTP retries and native-video/STT token billing
  are not observable here. No dollar/credit estimate is invented.

`totalMs = retrievalMs + preprocessingMs + synthesisMs`: retrieval includes
preflight, pacing/retries, response reads and mapping; preprocessing includes
input selection, media/video work and final citation/disclosure processing;
synthesis includes its full fallback/repair/backoff chain. `videoMs` is explicitly
**nested inside preprocessing**, never added again. These backend wall times omit
settings reload and UI/markdown formatting. Calls that fail entirely still throw
as before; these details cover completed answers, including recovered failures.
