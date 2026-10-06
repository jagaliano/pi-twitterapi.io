# What each route costs

A per-item cost comparison between [twitterapi.io](https://twitterapi.io/pricing)
(retrieval behind this extension's `twitter` tool) and
[xAI's `x_search`](https://docs.x.ai/developers/pricing#tool-invocation-costs),
including the counting rules that change the bill and how to add the cost of the
answer itself.

**Verified on 2026-10-03** against the two pricing pages and the per-endpoint
documentation linked below. Prices change: re-verify before relying on any number
here, and treat every ratio as a snapshot rather than a guarantee.

## The two routes bundle different things

This matters more than any per-item rate, because the totals are not
like-for-like:

| | `pi-twitterapi.io` | xAI `x_search` |
|---|---|---|
| Retrieval | twitterapi.io REST API, billed per item | xAI's server-side X index, billed per item |
| The answer | **your** pi model (`twitter.synthesisModel`, else the session model) | Grok, in the same request |
| Billing boundary | retrieval + your model's tokens, separately (plus any opt-in video/STT endpoints you configure) | retrieval + Grok's tokens, together |
| Who decides how much is fetched | you (`count`, `limit`, `maxPages`, `pageSize`) | the model, autonomously |

Both sides bill the answer as tokens. The difference is *whose* tokens: here you
choose the model and therefore the rate, while `x_search` uses a Grok model and
the docs note that "since the agent autonomously decides how many tools to call,
costs scale with query complexity."

## Unit prices

twitterapi.io prices in credits, where **100,000 credits = $1.00**
(1 credit ≈ $0.00001). xAI prices per item fetched, in addition to tokens.

| Billable unit | twitterapi.io | xAI `x_search` | Ratio |
|---|---|---|---|
| Posts / tweets | **$0.15 / 1K** (15 credits each) | **$5 / 1K** | **33× cheaper** |
| Profiles / users | **$0.18 / 1K** (18 credits each) | **$10 / 1K** | **56× cheaper** |
| Followers / followings | $0.01–0.03 / 1K, tiered by page size | not offered | — |
| Follower IDs (bulk) | from $0.0045 / 1K, tiered | not offered | — |
| Minimum per call | $0.00015 (15 credits); 60 credits for the follower endpoints | none listed — per item | — |
| List calls | $0.0015 (150 credits) per call | — | — |
| Images / video in posts | tokens on your model; opt-in native video is billed by the endpoint you configure | tokens (`view_image` / `view_x_video`) | — |

## Counting rules that change the bill

**xAI `x_search`** is billed per item fetched, not per call:

- every post returned by a search **or a thread fetch** counts toward the post
  rate, **including parent and quoted posts**;
- every profile returned by a user search counts toward the profile rate;
- counts accumulate across all X Search calls in one request and are **not
  de-duplicated** — a post returned by two searches is billed twice;
- the docs say per-item pricing was "in effect as of September 21, 2026".

**twitterapi.io** bills per item returned, with floors:

- a call returning 0 or 1 tweet still costs the 15-credit minimum ($0.00015);
- follower/following calls have their own tier table and a 60-credit ($0.0006)
  minimum, because the smallest page is 20 items at 3 credits each;
- follower and following pricing *falls* as the page grows: 3 credits per item at
  20–99 returned, 2 at 100–199, and 1 at a full 200-item page. That means
  `pageSize` is a price control, not just a pagination control;
- credits never expire, and recharges add bonus credits (valid 30 days) plus up
  to 5% off at larger amounts.

## Cost per mode

The `twitter` tool has 17 modes. Each maps to one twitterapi.io endpoint and one
billable unit. "Quoted" means the rate appears in the linked official source;
"inferred" means the unit follows from the endpoint's documented return type, but
that endpoint's page does not restate a price.

| Mode | Endpoint | Billable unit | Rate | Basis |
|---|---|---|---|---|
| `posts` (default) | `/twitter/tweet/advanced_search` | tweets returned | $0.15 / 1K | inferred from the tweet unit rate |
| `users` | `/twitter/user/search` | profiles returned | $0.18 / 1K | inferred (endpoint returns user objects) |
| `thread` | `/twitter/tweet/thread_context` | tweets returned | $0.15 / 1K | inferred |
| `user` | `/twitter/user/last_tweets` | tweets returned | $0.15 / 1K | inferred |
| `replies` | `/twitter/tweet/replies/v2` | tweets returned | $0.15 / 1K | inferred |
| `quotes` | `/twitter/tweet/quotes` | tweets returned | $0.15 / 1K | inferred |
| `mentions` | `/twitter/user/mentions` | tweets returned | $0.15 / 1K | inferred |
| `tweets` | `/twitter/tweets` | tweets returned | $0.15 / 1K | inferred |
| `retweeters` | `/twitter/tweet/retweeters` | users returned | $0.18 / 1K | inferred |
| `community` | `/twitter/community/tweets` | tweets returned | $0.15 / 1K | inferred |
| `profile` | `/twitter/user/info` | profiles returned | $0.18 / 1K | inferred from the profile unit rate |
| `followers` | `/twitter/user/followers` | followers returned | $0.01–0.03 / 1K, tiered; 60-credit minimum | **quoted** (endpoint doc) |
| `followings` | `/twitter/user/followings` | followings returned | $0.01–0.03 / 1K, tiered; 60-credit minimum | **quoted** (endpoint doc) |
| `list` | `/twitter/list/tweets_timeline` | per call | $0.0015 (150 credits) | **quoted** for "list function calls"; whether this endpoint is included is not explicit |
| `trends` | `/twitter/trends` | not published | **unverified** | no price on the pricing page or endpoint doc |
| `about` | `/twitter/user_about` | not published | **unverified** | no price on the pricing page or endpoint doc |
| `space` | `/twitter/spaces/detail` | not published | **unverified** | no price on the pricing page or endpoint doc |

Every call is subject to the 15-credit ($0.00015) minimum unless the response
qualifies as bulk data.

## Worked examples (retrieval only)

Assumes pages full enough that no floor applies, and no media attached.

| Scenario | twitterapi.io | xAI `x_search` |
|---|---|---|
| Keyword search, 200 posts returned | 200 × 15 = 3,000 credits = **$0.030** | 200/1K × $5 = **$1.00** |
| Read a 40-post thread | 40 × 15 = 600 credits = **$0.006** | 40/1K × $5 = **$0.20** (every thread post counts) |
| 1,000 followers at a full 200-item page | 1,000 × 1 credit = **$0.01** | not offered |
| One profile lookup | 18 credits = **$0.00018** | 1/1K × $10 = **$0.01** |

On this surface the retrieval side is 33× cheaper for posts and 56× cheaper for
profiles. The gap in the other direction is capability, not price: `x_search`
also offers semantic search, which twitterapi.io has no equivalent for, and it
answers in the same call instead of handing the posts to a model you pay for.

## Adding the answer

Retrieval is only part of the bill. For both routes, the answer costs the tokens
the model reads and writes:

```
answer cost = (input tokens × input rate + output tokens × output rate) / 1,000,000
```

- **Here**, that is your pi model. A synthesized answer feeds retrieved posts
  into one prompt, so a search returning 200 posts is a large input prompt; set
  `twitter.synthesisModel` to whatever model you are willing to pay for.
- **With `x_search`**, the same arithmetic applies at the Grok model's rates, and
  reasoning tokens are billed too.

Neither side's total can be stated as a single number, because token volume
depends on how much text was retrieved and how long the answer is. Worked
example with a hypothetical rate: at $1 per 1M input tokens, a 20,000-token
synthesis prompt costs $0.02 — which is comparable to, or larger than, the
retrieval cost of a 200-post search in the table above. That is why this document
leads with per-item rates and refuses to quote a single "total per search".

Media behaves the same way on both sides: attached images are token costs, not
per-item charges. This extension attaches post images, and video posts as their
poster frame, only when the configured model accepts image input. With
`enableVideoProcessing` a video can instead be analysed properly — native video
through `gemini-files` or an `openai-compatible` endpoint, and/or local frames plus
STT — and those endpoint charges appear on their own providers' bills, outside the
retrieval and synthesis figures compared here.

## What this comparison excludes

- twitterapi.io's optional subscription and recharge bonus credits, which lower
  the effective rate further, and its trial credit;
- the official X API's own read prices (reported at roughly $0.005 per post read),
  which are a baseline rather than a route this extension can use;
- enterprise agreements, and write/post endpoints that this extension never calls;
- the token cost of the agent conversation itself, which is identical on both
  sides of this comparison and belongs to pi, not to the retrieval route.

## Sources

- twitterapi.io pricing: <https://twitterapi.io/pricing>
- twitterapi.io followers endpoint (tier table and minimum):
  <https://docs.twitterapi.io/api-reference/endpoint/get_user_followers>
- twitterapi.io followings endpoint:
  <https://docs.twitterapi.io/api-reference/endpoint/get_user_followings>
- xAI pricing, tool invocation costs:
  <https://docs.x.ai/developers/pricing#tool-invocation-costs>
- xAI `x_search` tool page (per-item rates, what counts as a fetched post, usage
  counters): <https://docs.x.ai/developers/tools/x-search>

## Reconciling your own spend

twitterapi.io reports credit usage per key in its dashboard. For `x_search`, each
Responses API response reports `x_posts_fetched` and `x_users_fetched` under
`usage.server_side_tool_usage_details`, which is what the per-item bill is
computed from — and what to check if a request costs more than expected, since
the model decides how many searches to run.
