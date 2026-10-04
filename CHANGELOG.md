# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-03

First release.

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

[Unreleased]: https://github.com/jagaliano/pi-twitterapi.io/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jagaliano/pi-twitterapi.io/releases/tag/v0.1.0
