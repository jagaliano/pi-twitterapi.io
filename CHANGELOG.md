# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Complete rendered-input budgeting across posts, accounts, trends and documents:
  catalogue context/output preflight before retrieval, UTF-8-byte text estimates,
  reserved output on every completion/repair/retry/fallback, and a clamped 60,000
  character backstop. Whole-source/media reservations precede preprocessing;
  actual final input is rechecked and citations follow delivered evidence.
- User-only exact-model `imageInputBounds` declarations for image-token/geometry/
  count/byte limits. Missing bounds now omit attachments with disclosure; bounded
  PNG/JPEG headers and shared slots are checked. Text-only/unbounded-image
  fallbacks remove manifests/references without altering the trusted question.
  Native-video/STT text remains eligible; existing 700-character text caps stay.
- Local input omissions and no-inline fallback Sources (deduplicated/capped at20)
  are disclosed separately from upstream retrieval incompleteness.
- Process-local, per-credential HTTP-attempt pacing across concurrent endpoints,
  first requests, pagination and retries. FIFO dispatch rechecks actual spacing;
  the largest active/previous interval is conservative across differing settings.
  Cancellation does not consume a queued slot; response reads and model work
  remain concurrent. Retry-After/backoff and no-retry-after-billed-body rules stay
  intact; media/provider hosts are excluded and idle credential digests expire.
- One-level quoted/reposted source context, including media-only sources and
  typed reply/language/quote metadata. Id-only stubs and deeper nesting are omitted.
- Original repost text and source identity remain distinct from the enclosing
  post; truncated RT copies are replaced by longer originals within existing caps.
- Valid fetched nested permalinks join inline and deduplicated fallback Sources.
  New context fields use the existing prompt-boundary and source-URL guards.
- Quoted/reposted media uses the existing shared image/video caps, attempt bounds
  and phase deadlines. Repeated assets share one attempt and ordered image slot;
  different videos sharing a poster retain distinct audio-processing identities.
  Exact decimal media `id_str` recognizes nested/standalone CDN query aliases only
  when media kind, file locations and duration bounds agree; actual URLs are not
  rewritten. Exact-locator deduplication survives optional IDs; late identity
  matches coalesce aliases before caps without losing source bindings.
- Media evidence carries enclosing and original-source identities separately,
  including anonymous sources and reordered candidates. Mirrored RT assets belong
  to the fetched original. Image references and speech stay under that source's
  heading; display fields retain the existing prompt guards.
- Multiple videos from one source retain separate evidence within the video cap;
  video-cap/deadline fallbacks are disclosed. Complete-input budgeting is described above.
- Valid entity destinations expand matching t.co tokens without fetching pages.
  Direct/legacy cards, accessibility alt text and article previews are guarded,
  source-scoped untrusted metadata, not destination/full-article/visual evidence.
  Link expansion checks whole tokens; mirrored alt text follows final asset
  ownership even when media understanding is disabled.
- Available author/profile counts, website and pin IDs are included. Pin IDs do
  not imply fetched content; supplied full timeline pins deduplicate, while
  missing/unknown pin content is disclosed without an extra paid lookup.
  Non-null timeline-pin shapes have synthetic coverage only. Existing 700-character
  post/bio caps remain pending complete-input budgeting.

## [0.3.5] - 2026-10-07

Phase 1 follow-up: close the remaining retrieved-metadata prompt boundaries.

### Fixed

- Retrieved handles, invalid dates, URLs, media kinds, video-evidence methods,
  document headings/body and photo/poster/frame labels can no longer emit extra
  prompt headers or source lines through embedded line separators.
- Malformed source URLs are omitted from prompts, inline citation matching and
  fallback Sources, with disclosure. Accepted fetched URLs remain unchanged;
  evidence matching keeps its raw identities separate from display rendering.
- X search routes are not treated as account profiles or cross-matched between
  different search queries. Valid profile query URLs remain supported.
- Document boundary rendering preserves trailing fields after newline expansion.

### Verified

- 342/342 tests pass, zero skipped; typecheck passes. The 30 new tests include
  parser-to-prompt boundaries, source rejection and valid-URL compatibility.
- Reverting the initial production guards causes 27 regression failures. The
  document-tail and search-profile corrections each fail their own test when
  reverted independently.
- Offline `pi -e ./src/index.ts` smoke reproduces the forged metadata header before
  the fix and blocks it afterward. Retrieval/completion were mocked; no fresh
  paid-provider matrix or Node 22.19 run is claimed.
- Independent review passed after both reported P1 findings were corrected.

## [0.3.4] - 2026-10-06

Documentation only — no behaviour change, and the published `src/` is otherwise
identical to 0.3.3.

### Changed

- The video opt-in note states the capability rule generically: a model that does not
  declare video input refuses the request, the refusal is disclosed, and the run
  degrades to frames and STT. Check the model's declared input modalities before
  choosing one, rather than assuming.

## [0.3.3] - 2026-10-06

Test and CI only. **No runtime behaviour changes** — the published `src/` is
identical to 0.3.2; the only files that differ in this tarball are `package.json`
(version) and this changelog. It exists because 0.3.2 shipped with a red CI on the
`engines` floor.

### Fixed

- **The test suite failed on Node 22.19, the declared `engines` floor.** Two tests
  in `src/video.test.ts` were cancelled with *"Promise resolution is still pending
  but the event loop has already resolved"*, and the first cancellation took the rest
  of the file with it (75 of 312). This was **pre-existing** — v0.3.1 fails the same
  way (50 of 264) — and had never been seen because CI only ran `lts/*`. The Node
  22.19 matrix added in 0.3.2 is what exposed it.

  Cause: a fake fetcher settled *only* when the abort signal fired, and
  `AbortSignal.timeout()` (used by `opSignal`) is **unref'd**. With no other pending
  handle, Node 22.19 empties the event loop before the timer fires; Node 24/26 happens
  to keep a handle alive. The fakes now carry a ref'd fallback timer that holds the
  loop open the way a real socket would. It cannot make a test pass for the wrong
  reason: the affected test asserts the sweep finished in under 5 s, so a fallback
  that won would fail it.

  This was never a production defect. A real request holds a socket open, and every
  phase is bounded by the caller's deadline independently of the abort signal.

### Verified

- 312/312 tests pass on **Node 22.19.0** (the floor) and on Node 26.10.0. The
  `engines: ">=22.19.0"` claim is now tested rather than assumed.

## [0.3.2] - 2026-10-06

Correctness pass from a review of the whole extension, not only the video tiers. This
release fixes output that was **wrong**, failures that were **silent**, and two
settings problems that could remove the tool or change a number without saying so.
No new features.

### Fixed

- **Frame labels were wrong by half a sampling interval.** `fps=N/D` emits frames at
  interval *starts*, but the labels assumed midpoints, so on a 120 s clip every frame
  was labelled 7.5 s away from where it was — and frame 1 was always the t=0 frame,
  which on real video is a black frame or a title card. Frames are now taken with one
  input seek per labelled timestamp, which is exact. Note that the obvious fix —
  seeking half an interval in and keeping `fps=N/D` — **does not work**: the `fps`
  filter does not compose with `-ss` (measured: it emitted frames from t≈3.97 when
  asked for t=2.0). The new test compares produced frames byte-for-byte against source
  frames selected independently by index, with real ffmpeg.
- **A blocked, empty or truncated native-video reply was silent.** Gemini answers a
  safety block with HTTP 200 and no parts; the adapter returned neither text nor
  error, so the run degraded to frames+STT and reported nothing. The reason
  (`promptFeedback.blockReason` / `finishReason`) is now disclosed, a `MAX_TOKENS`
  reply is refused instead of being published as a half-written visual description,
  and both adapters disclose a reply that is neither text nor error.
- **STT re-ran after native analysis had already said there was no speech.**
  `{"transcript": ""}` was normalised to `undefined`, which the `!transcript` gate
  could not tell apart from "not transcribed yet", so silent clips paid for a second
  transcription whose output was then published as native evidence. The gate now
  distinguishes the two, and a reply that says nothing about speech still allows STT.
- **Whisper hallucinations were published as evidence.** Whisper transcribes silence
  happily: a 30 s sine tone came back as "Thank you." and the 6 s one measured here
  as " .". `verbose_json` segment data was requested and then thrown away. Remote STT
  now drops a segment when `no_speech_prob > 0.6` **and** `avg_logprob < -1`, renders
  the rest as `[mm:ss] text`, and discards a transcript that is entirely a known
  hallucination phrase (while keeping the same phrase inside real speech).
  `whisper.cpp` gains `-sns`, an explicit `-nth 0.6`, and `--vad` when the new
  `whisperVadModelPath` is set.
- **Local transcription started without enough budget to finish** and was killed late
  after spending the whole video phase. It is now skipped up front with a disclosure
  when the remaining budget is below `clipSeconds × whisperRealtimeFactor`, and
  `whisperThreads` controls `-t` (default `min(8, availableParallelism())`).
- **Retrieved text could forge an evidence block.** A post, transcript or bio
  containing a newline plus `[n] @handle` and `permalink: <url>` could emit a block
  that the citation filter *accepted*, because the permalink it cited was one we
  really fetched: citations could not be invented, but attribution could be spoofed.
  All untrusted fields now go through one helper that owns the prompt's structure.
- **A malformed settings file removed the tool entirely.** A stray trailing comma in
  a cloned repo's `.pi/settings.json` threw during registration, so `twitter` was
  never registered — a silent, total failure. The file is now reported in Notes and
  registration proceeds with whatever the readable files supplied.
- **Numeric settings behaved inconsistently and silently.** Out-of-range values fell
  back to the default for some keys and clamped for others, with no note either way.
  All of them now clamp to the supported bound, fall back only when the value is not
  an integer, and disclose which value was used.
- **The model did not know what time it is**, so "today", "this week" and "latest"
  were answered against a training cutoff next to raw upstream dates. All four
  prompts now open with `Current time: <ISO UTC> (local: <zone>)` and post/account
  dates are rendered as ISO.
- **`mode="tweets"` did not disclose ids the upstream never returned**: asking for
  five posts and getting three reported only "3 post(s)".
- **Video evidence for a post without a permalink never reached the model** — it was
  collected, billed and then dropped, while the run still said "processed via".
- A download is accepted only as `video/mp4` (or with no content type at all) rather
  than any `video/*`, the Gemini upload URL from the endpoint's reply is accepted only
  when it is https on the host already configured, and the video model id is
  URL-encoded in the request path.

### Changed

- `peerDependencies` for `@earendil-works/pi-coding-agent` is `^1.0.0`, so a package
  manager that resolves peers refuses a pi older than that. `*` let any version satisfy
  the range. `^1.0.0` is the **supported minimum**, not the first release with the
  capability: `ModelRegistry` exists on 0.80.6 but has no `complete()` there, and
  `complete()` is present from 0.99.2 (both verified against the published tarballs).
  1.0.0 is the line this extension is actually tested against.
- The test glob is quoted. Unquoted, `sh` expanded `src/**/*.test.ts` to
  `src/*/*.test.ts`, so the first test added in a sub-directory would have silently
  reduced the whole run to that one file.
- The download streams through one `createWriteStream` instead of re-opening the file
  per chunk.
- New user-only keys: `whisperThreads`, `whisperRealtimeFactor`, `whisperVadModelPath`.
- Every numeric key now behaves the same way, including the pacing and page budgets
  (`minRequestIntervalMs`, `retryBaseDelayMs`, `maxPages`, `maxPagesCeiling`), which
  were the last ones still clamping or falling back silently.

### Fixed (review pass)

A review of the pass above found six further defects, all fixed and each covered by a
falsified test:

- **Non-Latin speech was discarded as "punctuation".** The filter tested `[a-z0-9]`,
  so a confident `你好` or `こんにちは` segment was dropped — every segment of a
  non-Latin clip, including with `sttLanguage: "auto"`. It now uses Unicode letter and
  number properties.
- **A write failure could take the host process down.** The download's write stream had
  no `error` listener until after all writes finished, and an `error` event with no
  listener is re-thrown as an uncaught exception. The listener is now attached before
  the first write, and the stream's `finish` event — not the `end()` callback, which may
  never fire after an error — settles the promise.
- **Failed frame seeks truncated the evidence silently.** Extraction returns the frames
  already taken, but the caller reported nothing when fewer arrived than were requested.
  It now discloses the requested and extracted counts (a short file and a failed seek
  are indistinguishable at that point, so both are stated).
- **Evidence could be attached to the wrong post.** Posts with neither an id nor a
  permalink all shared one placeholder key, so the last video block attached to every
  one of them. Evidence is now keyed by the post's position in the result list.
- **A partially filtered transcript was not disclosed.** Dropping some segments changed
  the answer with no note; it now says the transcript may be partial.
- **The hallucination note overclaimed.** It said the clip had "no speech" when the
  phrase alone was the evidence. It now states what was observed and what was decided.
- A profile display name reached the prompt raw, so a name containing a newline could
  forge structure the same way post text could.

### Added

- CI installs ffmpeg so the real-frame-timing test actually runs, and the matrix now
  covers the `engines` floor (22.19) as well as `lts/*`.

## [0.3.1] - 2026-10-05

Hardening and disclosure fixes for the video tiers, found by reviewing and
live-testing the 0.3.0 work. Nothing is published for a typo any more, and no
disclosure claims evidence that was not produced.

### Changed

- Native video is now **skipped** when `twitter.videoEndpointType` holds a non-empty
  string the extension does not recognise, instead of silently falling back to
  `gemini-files`.
  The value is still reported, but no provider is guessed: with a custom
  `videoEndpoint` also configured, guessing would have sent one provider's wire
  format to a host that was set up for another. Frames and STT still run, so a typo
  costs native analysis rather than producing a malformed request.

### Fixed

- A synthesis model without image input now says that its frames were skipped rather
  than dropping the visual half of the evidence silently, and it states what replaced
  them: a transcript, or nothing. Two claims that were not always true were caught in
  review and removed — that a transcript was *used* (it may never reach synthesis for
  a post with no permalink), and that a poster fallback had happened.
- A run that produced no video evidence no longer announces a poster-frame fallback
  to a model that cannot accept images: such a model can never receive the poster, so
  the answer now says the poster could not be attached.
- An unrecognised `twitter.videoEndpointType` is reported, naming the bad value and
  the accepted set, instead of quietly changing provider.

### Documentation

- The README states every phase of the video budget (request spacing, media phase,
  video budget, the poster-fallback reservation and the Gemini file deletion) and
  notes they are budgets rather than a strict additive timeline. It adds a measured
  cost note for native video, scoped to the models it was measured on — 258 video
  tokens per second, about $0.0031 per 120 s clip on `google/gemini-2.5-flash-lite` —
  and warns that local `whisper.cpp` is bound by your hardware: about three minutes
  for a 30 s clip with `large-v3-turbo` on CPU.
- `docs/x-search-comparison.md` and `docs/pricing-comparison.md` account for opt-in
  video and STT billing, and no longer describe video as poster-only.
- The README links directly to [ffmpeg.org](https://ffmpeg.org/) and
  [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) for downloads, states
  that CPU-only whisper.cpp works but is slow, and recommends an accelerated backend
  for local processing — Apple Silicon (Metal / Core ML / Accelerate), NVIDIA (CUDA),
  AMD (ROCm), Vulkan, OpenVINO, or an NPU such as Ryzen AI or Ascend.

## [0.3.0] - 2026-10-05

A second native-video provider, so video understanding is no longer tied to
Google. Still **off by default**: without `enableVideoProcessing` nothing here
runs and a video post is represented by its poster frame.

### Added

- `videoEndpointType: openai-compatible` — native video through any video-capable
  chat-completions endpoint that accepts the `video_url` data-URL shape, such as
  OpenRouter (`videoEndpoint`, `videoModel`, `videoApiKeyEnv`). Verified live with
  `google/gemini-2.5-flash-lite` and `qwen/qwen3.7-flash`, both of which read
  on-screen text out of a real post. Because the measured endpoint accepted
  request bodies past the `maxVideoBytes` ceiling, this adapter sends the clip
  inline and has no upload lifecycle: nothing is uploaded and nothing has to be
  deleted afterwards.
- README documents the OpenRouter configuration with a copy-ready JSON block.

### Security

- The `openai-compatible` endpoint keeps the existing key-to-host rules: it is
  used only when `videoApiKeyEnv` is set explicitly and the URL is `https://`, and
  that authorization is re-checked at the adapter boundary, so a caller-built
  config cannot send a key to a host the user never named.
- The clip is sent as a non-redirecting POST, so an authenticated body cannot be
  re-sent elsewhere by a redirect.

### Behaviour notes

- A native reply cut off at the token limit is **refused** rather than published.
  Half-written JSON would otherwise be kept whole as the visual description and
  suppress the frame fallback, which would put a broken answer into the notes as
  evidence. Frames and STT still supply the visuals in that case.
- The per-video analysis token cap is raised to 4,000, because reasoning-style
  models spend most of the budget thinking before they emit the JSON answer.
- An empty native reply now reports the provider's `finish_reason`, which is what
  distinguishes a reasoning-only reply from a rate-limited shared pool.
- A model that declares no video input refuses the request outright (HTTP 404 from
the endpoint), and the refusal is disclosed. Frames then come from the pi model, but
only when that model accepts image input; with a text-only pi model the run is
transcript-only and the missing frames are disclosed. Free shared-pool models on
OpenRouter (for example `google/gemma-4-*-it:free`) return HTTP 429 and degrade to
`frames+stt`, which is also disclosed in the answer.

### Fixed

- Selection of the clip to analyse is unchanged, but the `openai-compatible`
  adapter now prefers the same small, low-resolution variant as the Gemini path:
  native video models sample at roughly 1 fps, so the smaller upload is faster and
  cheaper without losing evidence.

### Documentation

- `docs/video-spike.md` records the measured results for both providers: the
  working `video_url` shape, the two plausible alternative spellings that fail
  **silently** with HTTP 200 while ignoring the video, the accepted request sizes,
  and the reachability of the Gemini Files path.
- A truncated or empty native reply is described in the README, and the claim that
  every chat-completions endpoint works is narrowed to video-capable ones.

## [0.2.0] - 2026-10-04

Opt-in real video understanding. **Off by default:** without
`enableVideoProcessing`, behaviour is unchanged and a video post is still
represented by its poster frame.

### Added

- Real video processing (`enableVideoProcessing`, which also requires
  `enableVideoUnderstanding`): native video through a Gemini endpoint
  (`videoEndpointType: gemini-files`, `videoModel`, `videoApiKeyEnv`), and/or
  frames via `ffmpegPath` plus a transcript from a remote STT endpoint
  (`sttEndpoint`, `sttModel`, `sttApiKeyEnv`, `sttLanguage`) or local whisper.cpp
  (`whisperCppBinary`, `whisperModelPath`).
- Bounds: `maxVideoSeconds` (120), `maxVideoBytes` (32 MiB), `maxFrames` (8),
  `maxVideosPerSearch` (1), `videoBudgetMs` (180 s, max 300 s).
- The method actually used is disclosed in the answer: `gemini-native`,
  `frames+stt`, `stt-only`, `frames-only` or `transcript-only`.

### Security

- Executable paths, endpoints and credential env names are read from **user
  settings only**; project-level values for those keys are ignored and disclosed.
- A custom `videoEndpoint` is used only when `videoApiKeyEnv` is set explicitly
  and the URL is `https://`, and that authorization is re-checked at the adapter
  boundary.
- ffmpeg is never handed a URL (`-nostdin`, `-protocol_whitelist file`) and media
  downloads stay on the SSRF allowlist, with redirects refused on authenticated
  requests.

### Behaviour notes

- A native upload happens only when the clip is provably inside
  `maxVideoSeconds`: it is trimmed locally first, and the native path is skipped
  with a disclosure when it cannot be bounded. A trimming failure never falls
  back to uploading the whole clip.
- The native reply is requested as structured JSON. A reply that ignores that is
  kept whole as visual evidence, so a transcript is never inferred from prose;
  STT can still recover the speech.
- Gemini Files uploads are deleted on a best-effort basis, including when
  generation failed or was cancelled; a file that could not be deleted is
  disclosed as possibly retained (Google keeps undeleted uploads for ~48 hours).
- Worst case a single video call can take several minutes.

### Fixed

- Video variants are now selected from a real `HEAD` request instead of the
  advertised bitrate. That bitrate is a target rather than an average and
  overstates the file by roughly 3x, so the old estimate picked a needlessly low
  resolution (640x360 where 1280x720 fitted) and could misjudge both caps.
- The video-phase budget defaults to 180 s and is capped at 300 s, up from 90 s
  and 120 s. Live measurement showed one provider call over a 65 s clip taking
  33 s to ~71 s with run-to-run variance, so the old ceiling aborted long videos
  and silently fell back to the poster frame.

## [0.1.2] - 2026-10-03

A dated, sourced cost comparison against xAI's `x_search`. No runtime change:
same tool, same modes, same behaviour.

### Added

- [`docs/pricing-comparison.md`](docs/pricing-comparison.md): unit prices for both
  routes, the counting rules that actually change the bill, cost per mode, worked
  retrieval-only examples, how to add the answer model's tokens, what the
  comparison excludes, and its sources.

### Changed

- The README comparison table links to that document, noting that the two routes
  meter different things: xAI bills tokens and per post/profile, while
  twitterapi.io bills credits plus your own model's tokens.

## [0.1.1] - 2026-10-03

First version published to npm.

### Added

- `twitter` tool backed by the [twitterapi.io](https://twitterapi.io) REST API, with 17 read modes:
  `posts` (default), `users`, `thread`, `user`, `trends`, `replies`, `quotes`, `mentions`, `followers`,
  `followings`, `profile`, `about`, `tweets`, `retweeters`, `community`, `list` and `space`.
- Answer synthesis with a pi model: `twitter.synthesisModel` when configured, otherwise the model running
  the current session, with a per-failure-kind fallback chain back to the session model.
- Citations derived from fetched permalinks only; invented X links are dropped and counted in the notes.
- Best-effort media understanding (`enableImageUnderstanding`, `enableVideoUnderstanding` with poster
  frames), bounded paging with early-stop disclosure, and per-mode parameter validation.
- Strict settings parsing for the `twitter` block in `~/.pi/agent/settings.json` and
  `<cwd>/.pi/settings.json`.

### Fixed

- README no longer claims a peer range of `>=0.99.2 <2`; the host packages are declared as peers with
  `"*"`, and the `ModelRegistry.complete` requirement is documented separately from that range.
- The release workflow decides publishing and GitHub-release creation separately, so a rerun after a
  failed release step skips the immutable npm version instead of failing on it and repairs the release.
  A registry lookup that fails for any reason other than "not found" now fails the run loudly.
- The `mode`, `queryType` and `replySort` tool parameters are closed literal unions rather than free-form
  strings, and the tests assert both the accepted and rejected values.

### Changed

- Package layout: the pi manifest loads `./src/index.ts` directly and the tarball ships the TypeScript
  sources (tests excluded), so there is no build step; `tsdown` and `dist/` are gone.
- Release workflow actions are pinned to commit SHAs, checkouts do not persist credentials, `ci.yml` runs
  with `contents: read`, and the publishing job does not use a package-manager cache.

## [0.1.0] - 2026-10-03

Tagged but never published. Superseded by [0.1.1](#011---2026-10-03), which carries the same features
plus the fixes above; the entry is kept because the git tag exists.

[Unreleased]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jagaliano/pi-twitterapi.io/releases/tag/v0.1.0
