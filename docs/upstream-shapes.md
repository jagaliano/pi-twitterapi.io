# Phase 2 upstream field spike (internal)

Captured 2026-10-07 from twitterapi.io. This is a **bounded consumer inventory for
2.2–2.4**, not a complete provider schema or a lossless raw-payload archive.
Fixtures and this document are excluded from npm.

## Sample and provenance

Seven successful reads: five single-page `advanced_search` queries for quotes with
video, native reposts, replies, links, and posts from two public technology
accounts; one `user/info` and one `user/last_tweets` for a public science account.
Each search and the timeline returned 20 posts. Requests were sequential, with
six seconds between calls. No synthesis, video download or external link fetch.
Post-review verification also fetched the seven selected source ids together via
`/twitter/tweets`. That endpoint exposed additional card wrapping and article
omission, documented below rather than treated as a universal search schema.

Raw captures are temporary under `/tmp/twitter-phase2-raw/`. The local consumed-field
projection script is `/tmp/twitter-phase2-project.mjs`. These temporary artifacts
are available for the current review, not durable prerequisites for the tests.
`src/fixtures/upstream-context.json` records capture time and per-example source
case/index/path. Values are synthetic; the fixture does not contain original post
prose, names, handles, post/account ids, post timestamps or shortlink tokens.
Public media hosts and numeric video durations/bitrates are retained where needed
by media consumers. Engagement/profile counts are synthetic.

The projection intentionally omits unused keys, limits nesting to one context
level, caps MP4 variants at two, selects four consumed card bindings, and uses one
post rather than the complete timeline page. It preserves selected scalar types,
source/author relationships, repost prefix/longer-original behavior, and link-token
correspondence; **no complete key/type/array-length fidelity is claimed**. Opaque
GraphQL/base64 identifiers and unrelated card/image bindings are not included or
decoded. This is not a reusable redaction framework.

## Measured fields consumed by 2.2–2.4

| Consumer | Upstream location / type | Observation and limit |
|---|---|---|
| Quoted context | `quoted_tweet`: object or null | Full post with text, author and media, not merely an id. All 20 quote-search results supplied a non-empty quoted post; 3 carried video in the quoted original. Separate enclosing/original source identity is required. |
| Repost context | `retweeted_tweet`: object or null | All 20 repost-search results supplied an original. Nine originals were longer than the top-level RT copy; selected fixture is 140-character copy versus 300-character original. Preserve the `RT @handle: ` prefix for classification. |
| Reply/language/counts | `isReply`: boolean; `inReplyToUsername`: string or null; `lang`: string; `quoteCount`, `replyCount`, author `followers`: number | All 20 reply-search posts had reply flags. Keep reply targets as metadata, not an invented fetched conversation. |
| URL expansion | `entities.urls`: array of objects with `url`, `expanded_url` strings | Link-search results supplied 20 entries across enclosing/nested posts. Expanded destinations are populated. Preserve exact t.co token-to-entry correspondence; keep opaque tokens when no entity matches. Do not fetch destinations. |
| Link cards | `card`: object or null; `name`, `url`: strings; `binding_values`: **array** | The search/timeline captures use `{ key, value }` entries, not the object-map shape previously encountered. The fresh `/twitter/tweets` capture puts that same array under `card.legacy.binding_values`; another by-id card had only an opaque `rest_id` and no readable metadata. Consumed `title`, `description`, `domain`, `card_url` entries carry `value.string_value`. No `value.type` was present in the selected string entries; `card_url` also had unused `scribe_key`. Selected `summary_large_image` card URL and its `card_url` binding match an entity's shortened URL. Support alternate shapes only when explicitly labelled/tested; do not infer wrappers. |
| Long post | `text`: string | A top-level post in the long-post sample is 801 characters, exceeding the current 700-character cap. Nested/enclosing quote sample maximum is 970. Increasing delivery caps depends on the 2.6 complete-input budget. |
| Article preview | `article`: object or null | One article in the quote sample. Exactly `title`, `preview_text`, `cover_media_img_url` strings were supplied. This is a preview, **not a full article body**. The fresh by-id endpoint omitted the `article` key on the selected sources, including that article post; availability is endpoint-specific. |
| Alt text | `extendedEntities.media[].ext_alt_text`: optional string | Two media entries in the quote sample and six in the timeline supplied alt text. Render as untrusted accessibility text, not guaranteed visual analysis. |
| Media | `extendedEntities.media` array; `type`, `media_url_https`; `video_info.duration_millis`, `variants[].content_type/bitrate/url` | Quote and repost originals have media independent of the enclosing post. MP4 variants and poster images must retain their roles and safe Twitter media hosts. Shared caps/deduplication must not confuse source attribution. |
| Profile counts/website | `data.statusesCount`, `mediaCount`: numbers; `data.entities.url.urls`: URL-entry array | Profile includes count and website fields absent from the current normalized profile. Root `url` is not a fetched post/profile citation; use validated expanded website evidence only. |
| Profile pins | `data.pinnedTweetIds`: array | Empty in the single sampled profile. Non-empty id element is a **synthetic edge case**, not a live observation. |
| Timeline pins/envelope | `data: { tweets, pin_tweet }`; top-level `has_next_page`, `next_cursor` | `pin_tweet` was null. Its non-null schema remains **unverified**; do not invent a measured object or promise pinned-post availability. |

## Fixture index

All `live.*` examples are **projected live shapes with synthetic values**:

- `quoteVideo`: enclosing and quoted videos, distinct ids/authors/media URLs.
- `retweet`: RT copy and longer original; distinct source and original authors.
- `reply`: reply target, language and quote/reply counters.
- `linkCard`: populated expanded entity URL, matching t.co token/card URL, measured
  array-shaped string bindings.
- `linkCardByIds`: the same source fetched by id, with measured `card.legacy`
  wrapping around those bindings and an omitted `article` key. Its later capture
  timestamp is recorded in the example's source metadata.
- `longPost`: 801-character synthetic text.
- `article`: title/preview/cover only, selected from the quote sample.
- `photoAlt`: accessible photo metadata selected from the timeline.
- `profile`: selected `user/info.data` fields, empty pin ids.
- `timeline`: selected `data.tweets` member, null pin and top-level paging fields.

`synthetic.*` contains explicitly labelled parser cases: media-only quote, deeper
nesting/stub, and non-empty profile pin ids. These are not additional live evidence.
No non-null timeline pin object or alternate card-map shape is represented as live.
The by-id legacy wrapper is measured, not an inferred alternate map.

## Acceptance and follow-up

`src/upstream-fixtures.test.ts` checks source/author consistency, parser acceptance,
quote/repost/reply coverage, RT-prefix and longer-original behavior, actual card
array shape and link correspondence, >700-character text, preview-only article,
alt text, profile/timeline relationship, synthetic labels and package exclusions.
It does not assert the Phase 2 consumers are implemented yet.

Post-review verification made four fresh endpoint reads: one batch for the seven
selected sources, another quote-search page (20 posts), profile, and timeline.
The batch confirmed quote video, longer repost original, reply metadata,
link/card correspondence, long text and alt text; it also revealed `card.legacy`
wrapping and missing article keys. The second quote page had no article, so the
initial measured preview is retained without claiming repeat availability.
Profile pin ids remained empty and timeline pin stayed null. The same account's
normalized profile/timeline identity matched. No synthesis/video processing or
global settings changes occurred.

The first batch check initially failed its universal direct-card assumption;
the inventory and a tenth projected case now describe the measured endpoint
difference. Narrow reviewer verification follows this correction before the
commit. Optional-field absence does not erase initial evidence or make a synthetic
pin a live success. Each later task has its own end-to-end live gate.
