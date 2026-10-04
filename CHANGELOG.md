# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
