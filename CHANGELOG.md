# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Grok cannot be used here.** `x-ai/grok-4.3` declares no video input and
  rejects the request with HTTP 404 "No endpoints found that support input
  video"; it remains a frames-only option. Free shared-pool models on OpenRouter
  (for example `google/gemma-4-*-it:free`) return HTTP 429 and degrade to
  `frames+stt`, which is disclosed in the answer.

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

[Unreleased]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jagaliano/pi-twitterapi.io/releases/tag/v0.1.0
