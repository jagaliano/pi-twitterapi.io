# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jagaliano/pi-twitterapi.io/releases/tag/v0.1.0
