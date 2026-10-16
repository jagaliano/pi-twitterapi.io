# Answer output versus evidence output

[README](../README.md) · [Output contract](tool-reference.md#evidence-output)

## Method

Protocol amended **2026-10-16**, before the replacement experiment. This closes
the experiment left unfinished at 0.5.0; it does not retroactively supply that
release with measurements. The local 0.5.6 working tree includes the separately
reviewed post-ID batching fix. No production behavior changes for this benchmark.

Evidence output is **not** a final answer. Compare complete workflows:
- **Answer:** retrieve → extension synthesis → caller's final answer.
- **Evidence:** retrieve → text evidence → caller's final answer.

The owner approved a controlled replacement model pair:
**`google/gemini-2.5-flash-lite` for both extension synthesis and final caller**.
This isolates output-mode differences under one model; it does **not** validate
the configured MuseSpark/Sonnet workflow that failed during setup (see below).
Both final answers use a fresh standalone caller completion with identical
question/system instructions, requested reasoning off, a 1,024-token output ceiling, and
no conversation history or tools. Extension synthesis retains its normal
4,096-token budget. This is not every possible Pi agent's conversation overhead.

### Fixed queries

Exact questions/arguments and runner:
[`scripts/benchmark-output.ts`](https://github.com/jagaliano/pi-twitterapi.io/blob/main/scripts/benchmark-output.ts).
- `tweets`: written investment message in post `2107226494934061502`; distinguish
  author/quoted words, cite fetched sources, do not infer video content.
- `profile`: NASA's stated remit, linked website and fetched profile citation;
  distinguish profile claims from verification; exclude follower counts.
- `user`: topics of three returned NASA timeline posts, source citations and
  original/quoted attribution; do not imply exhaustive coverage.

One paired trial per query, **n=3 pairs**, three modes. Order is answer-first,
evidence-first, answer-first. Live retrieval is independent for each arm, not
replayed: retain private response hashes/source payloads and inspect changes.
Fixed inputs do not guarantee identical upstream data.

### Bounds and conditions

The replacement run permits **six TwitterAPI retrieval HTTP attempts and nine model SDK
invocations**, including all caller work. Stop on any failure; no automatic
restart, fallback generation or parameter-repair spending. Including failed setup
and its authorized diagnostic, the owner-approved overall ceilings are **seven
TwitterAPI retrieval requests and twelve model SDK invocations**. These are SDK invocation
limits, not a dollar ceiling or proof of provider-internal HTTP request counts.
The runner asks the SDK not to retry; provider/authentication behavior may not be
fully observable. Independent code-review calls are outside experiment counters.

Images, native video, frames, STT and persistent evidence caching are disabled.
One page maximum, `maxPagesCeiling=1`, `maxSynthesisChars=20000`, retrieval interval
5,000 ms. The timeline retains at most three posts but its returned page can be
larger and billed accordingly. Five seconds' cooldown before each timed trial
prevents the previous retrieval gap being charged to the next mode's latency.
Cooldown, startup, discovery and independent review are outside trial timings.
No warm-up requests: local process state starts cold and is then reused. Remote
caches cannot be forcibly cleared; report SDK cache usage, not assumed coldness.

Record time to tool result **and equivalent final answer**, retrieval attempts,
accepted pages, returned/retained entities, extension/caller SDK invocations,
requested/SDK-reported model identities, reasoning options and reported tokens.
Missing token fields or unsuccessful calls are **unknown**, never zero. Catalogue
`usage.cost` is not a verified bill. No monetary estimate is made without a dated,
verified rate for the specific provider/account. Subscription quota and marginal
cash charges are different things.

### Quality rubric

Assess each final answer against its own captured sources, with explicit reasons.
Scores are descriptive, not a blinded human study or model leaderboard:
- **Grounding, 0–2:** 2 = substantive claims supported; 1 = minor unsupported
  inference/overstatement; 0 = major invented or contradicted claim.
- **Citations, 0–2:** 2 = substantive claims linked to correct fetched sources;
  1 = incomplete coverage; 0 = invented/misattributed sources or no usable links.
- **Context, 0–2:** 2 = relevant source/quote distinctions and limitations retained;
  1 = useful context lost; 0 = material attribution or omitted-media confusion.
- **Usefulness, 0–2:** 2 = concise, direct response to the fixed question;
  1 = partly useful/needlessly indirect; 0 = fails the task.

Do not reward a small answer merely for being cheap. A larger/slower answer may
retain more useful context. Report pairs individually; three examples cannot
establish universal latency, price or quality savings. Failed and unknown work
remains visible rather than disappearing from a successful average.

## Results

Completed **2026-10-16 18:38–18:39 UTC**, Pi **1.3.0**, Node **v26.12.0**.
All six retrieval responses were HTTP 200; all nine replacement SDK invocations
succeeded. No enclosing agent turn occurred in the replacement's prompt-free RPC
process. Three pairs completed; no additional runs or quality-repair calls.

### Latency and measured work

Times are seconds. **Final** includes caller completion for both routes; tokens
also include **all extension and caller invocations**, not just the tool's usage.
Each row used one retrieval attempt and one accepted page. Cache-read/cache-write
usage reported zero for every replacement invocation; no cache rate is assumed.

| Query | Tool output | Tool s | Final s | Extension + caller SDK calls | Input / output tokens | Total tokens | Returned / retained roots |
|---|---|---|---|---|---|---|---|
| Post | `answer` | 3.106 | 4.025 | 1 + 1 | 1,613 / 333 | 1,946 | 1 / 1 post |
| Post | `posts` | 0.939 | 2.159 | 0 + 1 | 1,050 / 181 | 1,231 | 1 / 1 post |
| Profile | `answer` | 1.130 | 1.642 | 1 + 1 | 696 / 101 | 797 | 1 / 1 account |
| Profile | `posts` | 0.487 | 0.979 | 0 + 1 | 420 / 39 | 459 | 1 / 1 account |
| Timeline | `answer` | 2.905 | 3.903 | 1 + 1 | 1,931 / 421 | 2,352 | 20 / 3 posts |
| Timeline | `posts` | 1.461 | 2.594 | 0 + 1 | 1,285 / 152 | 1,437 | 20 / 3 posts |

The evidence route reached a final answer **46.4%, 40.3% and 33.5% sooner** in
these individual pairs. This is one observation per arm/query, not a confidence
interval or universal speed claim. Root counts exclude embedded quote/repost
contexts; retaining three timeline posts did **not** reduce the 20-item upstream
page. Retention is not a retrieval-cost ceiling.

The post pair's complete upstream payload matched byte-for-byte. Profile and
timeline payloads differed in metadata, but question-relevant profile fields and
retained post IDs/text/nested source text matched. Both routes retained the same
root count. Network/provider variability, chronological ordering, remote cache
state and the controlled caller remain confounders.

### Model-only price equivalent, not an actual bill

The official [Gemini pricing table](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash-lite),
verified **2026-10-16**, lists Standard paid-tier text input at **$0.10/1M tokens**
and output, including thinking, at **$0.40/1M**; it also lists a free tier. Applying
that *hypothetical paid-tier rule* to the measured noncached tokens gives:

| Query | `answer` model equivalent USD | `posts` model equivalent USD |
|---|---|---|
| Post | $0.0002945 | $0.0001774 |
| Profile | $0.0001100 | $0.0000576 |
| Timeline | $0.0003615 | $0.0001893 |
| Three-query sum | $0.0007660 | $0.0004243 |

Calculation: `(input × 0.10 + output × 0.40) / 1,000,000`. It includes caller
work in both routes. These are **model-token list-price equivalents only**:
actual account tier/credits, retrieval fees, failed setup/diagnostic work, the
extra Sonnet turn, independent review and other charges are excluded. Actual
all-in monetary cost remains **unknown**. Do not call this a measured cash saving.

### Quality and retained context

Parent-assistant, unblinded scores under the rubric above (0–2 per column),
independently source-checked by `openai-codex/gpt-6.1-sol`; this is not a human study:

| Query | Tool output | Grounding | Citations | Context | Usefulness | Total / 8 |
|---|---|---|---|---|---|---|
| Post | `answer` | 2 | 2 | 2 | 2 | 8 |
| Post | `posts` | 2 | 2 | 2 | 2 | 8 |
| Profile | `answer` | 2 | 2 | 2 | 2 | 8 |
| Profile | `posts` | 2 | 2 | 2 | 2 | 8 |
| Timeline | `answer` | 2 | 2 | 1 | 2 | 7 |
| Timeline | `posts` | 2 | 0 | 2 | 2 | 6 |

Both post answers stayed within the written source and cited its fetched
permalink, without inventing unprocessed video/article contents. Both profile
answers returned the stated slogan/website and fetched profile citation without
claiming independent verification. All final answers met their word limits.

For the timeline, the answer route linked all three fetched NASA posts but lost
the first post's **NASASpox repost attribution**. The evidence route preserved
that attribution yet returned **bare `[1]`/`[2]`/`[3]` markers with no URL legend**:
its final answer had no usable linked citations, despite an explicit instruction
to include them. It was not silently repaired or rerun. Usefulness assesses the
topic summary separately; the citation failure receives its own zero score.

**Conclusion:** the evidence route removed one synthesis invocation per query
and was faster/used fewer reported tokens here. It still required caller work,
and the timeline result failed the final citation requirement. Prefer it only
when the caller reliably preserves source URLs and needed context; these data do
not establish equal quality or general savings across models and workloads.

## Failed setup and lifecycle correction

The original configured pair was `opencode-go/muse-spark-1.3-contributor` synthesis
and `anthropic/claude-sonnet-4-6` caller. Its first attempt stopped after one
successful post lookup and one unsuccessful synthesis invocation: **zero completed
pairs**. The original failure's cause was not retained. One separately approved
diagnostic reused that saved response, made **no new retrieval**, and confirmed
HTTP 400 without a recognized reasoning-parameter error. It did not resolve the
underlying cause. Usage for both failed SDK invocations remains unknown.

A harness defect also let print mode start an enclosing Sonnet turn after the
first attempt ended. That extra invocation reported **138 input / 277 output
/ 415 total tokens**, with zero reported cache tokens. It is setup overhead,
not a comparison result, and is included in the overall work count. No verified
monetary bill is claimed from the SDK's catalogue-derived cost field.

The runner now explicitly handles startup input so the enclosing agent cannot
add work outside its ledger; `ctx.shutdown()` alone was insufficient. A real Pi
subprocess test uses a callable, network-free provider, proves the provider can
answer without the runner, then verifies no enclosing turn with the guard. Removing
the guard fails the test. Diagnostics retain only sanitized error categories/status
codes, not provider error text or credentials. Failed-pilot records are preserved
privately and are not silently replaced by successful measurements.

## Reproduce safely

Repository-only runner; it is excluded from the npm package. Both
`TWITTER_BENCHMARK_APPROVED=9` and `TWITTER_BENCHMARK_DIR` must be explicitly set.
Obtain a fresh paid budget before each new run. Use a new private directory; an
existing `result.json` refuses implicit replay. Raw public source payloads and
answers stay private, not in this report. Never attach credentials/auth files.

Run an isolated Pi CLI process with `-e ./scripts/benchmark-output.ts`, JSON/print
mode, no tools/context discovery or persisted session, and the provider setup
required by the approved model. The runner handles the enclosing prompt rather
than allowing an unmeasured agent response. Do not load the armed runner into a
working interactive session: it owns input for that experiment. Loading without
the two opt-ins runs nothing. Saved user/project settings are never edited.
