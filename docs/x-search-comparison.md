# `pi-twitterapi.io` vs xAI's official `x_search`

This document compares the `twitter` tool from `pi-twitterapi.io` with xAI's
official **X Search** (`x_search`) server-side tool. It is meant to be read
alongside the [README](../README.md).

## How each one works

**xAI `x_search`** is a server-side tool on the Grok API. You enable it with
`{ "type": "x_search" }` and Grok decides which of four underlying operations to
run:

- `x_keyword_search` — literal/keyword post retrieval
- `x_semantic_search` — retrieval by meaning
- `x_user_search` — profile/account discovery
- `x_thread_fetch` — a post's whole thread

xAI runs the retrieval and Grok writes the answer, so one request does
everything. It is only available on xAI models; there is no non-xAI fallback.

**`pi-twitterapi.io`** registers one `twitter` tool with 17 modes. Each mode maps
to a twitterapi.io REST endpoint; the retrieved posts, accounts or metadata are
then handed to a pi model (`twitter.synthesisModel`, else the session model) that
writes the answer with citations. Retrieval and synthesis are two separate steps,
which is why the two are priced differently.

## Capability comparison

| Capability | xAI `x_search` | `pi-twitterapi.io` |
|---|---|---|
| Retrieval source | xAI server-side X index | twitterapi.io REST API |
| Credential | `XAI_API_KEY` | `TWITTERAPI_IO_API_KEY` |
| Keyword post search | ✅ `x_keyword_search` | ✅ `mode=posts` → `/twitter/tweet/advanced_search` |
| Semantic search | ✅ `x_semantic_search` | ❌ no equivalent |
| User/account search | ✅ `x_user_search` | ✅ `mode=users` → `/twitter/user/search` |
| Thread fetch | ✅ `x_thread_fetch` | ✅ `mode=thread` → `/twitter/tweet/thread_context` |
| Account timeline | ❌ | ✅ `mode=user` → `/twitter/user/last_tweets` |
| Trends by location | ❌ | ✅ `mode=trends` → `/twitter/trends` |
| Replies to a post | ❌ | ✅ `mode=replies` → `/twitter/tweet/replies/v2` |
| Quote-posts | ❌ | ✅ `mode=quotes` → `/twitter/tweet/quotes` |
| Mentions of an account | ❌ | ✅ `mode=mentions` → `/twitter/user/mentions` |
| Followers / followings | ❌ | ✅ `mode=followers` / `mode=followings` |
| Single profile lookup | partial (via user search) | ✅ `mode=profile` → `/twitter/user/info` |
| Extended profile ("about") metadata | ❌ | ✅ `mode=about` → `/twitter/user_about` |
| Fetch posts by id | ❌ | ✅ `mode=tweets` → `/twitter/tweets` |
| Users who reposted a post | ❌ | ✅ `mode=retweeters` → `/twitter/tweet/retweeters` |
| Communities | ❌ | ✅ `mode=community` → `/twitter/community/tweets` |
| Lists | ❌ | ✅ `mode=list` → `/twitter/list/tweets_timeline` |
| Spaces | ❌ | ✅ `mode=space` → `/twitter/spaces/detail` |
| Handle filters | ✅ `allowed_x_handles` / `excluded_x_handles`, max 20, mutually exclusive | ✅ same names, `mode=posts` |
| Date range | ✅ `from_date` / `to_date` (`YYYY-MM-DD`) | ✅ same names, `mode=posts`; unix `sinceTime`/`untilTime` for `quotes`/`mentions` |
| Result order | chosen by the model | ✅ `queryType` (`Latest`/`Top`), `replySort` (`Relevance`/`Latest`/`Likes`) |
| Item-count control | ❌ | ✅ `count` (posts/users/trends), `limit` (many modes) |
| Image understanding | ✅ `enable_image_understanding` | ✅ `enableImageUnderstanding` (attached only when the model accepts images) |
| Video understanding | ✅ `enable_video_understanding` | ⚠️ poster frame only — chat models cannot ingest video, and this is disclosed |
| Answer generation | Grok (xAI) | any pi model: `twitter.synthesisModel`, else the session model, with runtime fallback |
| Citations | xAI annotations/citations | derived from fetched permalinks; unmatched X links dropped and disclosed |
| Billing | xAI model tokens + per post/profile fetched | twitterapi.io credits + your synthesis model's tokens |
| Tool shape | one `x_search` call | one `twitter` tool, 17 modes |
| Availability | xAI models only | any pi session with a twitterapi.io key |

## Parameter mapping

| xAI `x_search` | `pi-twitterapi.io` |
|---|---|
| `allowed_x_handles` | `allowed_x_handles` (`mode=posts`) |
| `excluded_x_handles` | `excluded_x_handles` (`mode=posts`) |
| `from_date` | `from_date` (`mode=posts`) |
| `to_date` | `to_date` (`mode=posts`) |
| `enable_image_understanding` | `twitter.enableImageUnderstanding` setting |
| `enable_video_understanding` | `twitter.enableVideoUnderstanding` setting (poster frames) |
| — | `mode`, `tweet`, `user`, `userId`, `woeid`, `ids`, `communityId`, `listId`, `spaceId`, `queryType`, `replySort`, `count`, `limit`, `pageSize`, `includeReplies`, `sinceTime`, `untilTime` |

## Where `x_search` is stronger

**Semantic search.** `x_semantic_search` retrieves posts by meaning, not word
match. twitterapi.io exposes no semantic endpoint — `advanced_search` is
keyword/operator based. The closest approximation is to let the synthesis model
expand a natural-language question into advanced-search operators
(`"a" OR "b"`, `min_faves:`, `lang:`, `-filter:replies`), which is a heuristic,
not true semantic retrieval.

## Where `pi-twitterapi.io` is stronger

Everything below has no `x_search` equivalent and is a first-class mode here:
account timeline, trends, replies, quotes, mentions, followers, followings,
profile, about, fetch-by-id, retweeters, communities, lists and Spaces.

## Behavioral differences worth knowing

- **Two steps, not one.** `x_search` bills xAI tokens plus per-item retrieval;
  this extension bills twitterapi.io credits plus tokens on the pi model you
  choose. Choosing a cheap synthesis model for summaries keeps cost down.
- **Citations are reconstructed.** This extension never trusts model output for
  sources: citations are derived from the permalinks actually fetched, and an X
  link the model invents is dropped from `Sources` and disclosed in `## Notes`.
- **Retrieval honesty.** Paging can stop early (page cap, cursor cycle, missing
  cursor); when it does, the answer carries a note saying the results may be
  incomplete. Trends have no permalink, so their sources are X search URLs.
- **Cancellation is not retried** by the synthesis fallback. A cancellation is
authoritative from the aborted signal or `AbortError`, not from provider text;
a message such as "connection aborted" is classified as a transport failure and
routed like any other.
- **Images respect the answering model.** Media is attached only for a model that
accepts image input; if the primary fails and a text-only fallback answers, the
images are dropped (and the answer discloses it) instead of being sent to a model
that would reject them.
- **Date boundaries are 04:00 UTC as observed, with conservative padding.** The
upstream resolves `since:` day boundaries at 04:00 UTC in the probed season; if
that is really US-Eastern local midnight it shifts to 05:00 UTC in winter, so the
start padding is one hour wider to avoid silently dropping the first hour of the
local day. Far-west offsets can lose the tail of the requested day (disclosed),
and far-east offsets can spend free pages on the newer trim band.

## Sources

- xAI X Search docs: https://docs.x.ai/developers/tools/x-search
- xAI tool usage details: https://docs.x.ai/developers/tools/tool-usage-details
- twitterapi.io docs: https://docs.twitterapi.io/introduction
