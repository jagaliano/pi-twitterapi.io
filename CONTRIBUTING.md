# Contributing

[README](README.md)

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

Load a local checkout with:

```bash
pi -e ./src/index.ts
```

There is no build step. Pi loads the TypeScript sources in `src/` directly
through [jiti](https://github.com/unjs/jiti), and the published package ships
those sources, so `pi install npm:pi-twitterapi.io` and
`pi install git:github.com/jagaliano/pi-twitterapi.io` both work without a
compile step. Tests live in `tests/`, with fixtures in `tests/fixtures/`; both
are typechecked and excluded from the npm tarball.

The dev dependencies are version ranges (pi 1.0.2, typebox 1.3.x) resolved by
[`pnpm-lock.yaml`](pnpm-lock.yaml); CI installs them with `--frozen-lockfile`,
so a build is reproducible from the lockfile rather than from the manifest.

## Releases

**Pushing a `v*` tag publishes automatically.** Version bumps, commits, pushes
and publication are separate maintainer decisions; documentation-only changes
can wait for the next release. A manual `npm publish` bypasses the workflow gates.
Use pnpm for dependency installation and checks; the npm commands below handle
package versioning and publication.

1. `pnpm typecheck && pnpm test`
2. Update [`CHANGELOG.md`](CHANGELOG.md), then bump the version with
   `npm version patch` (or `minor`), which also creates the git tag
3. `git push origin main --tags` — a `v*` tag makes `.github/workflows/release.yml`
   publish it (using `NPM_TOKEN` or configured npm trusted publishing) and open
   the GitHub release
4. Or publish by hand: `npm publish --access public`

### Rehearsing a release

The pipeline can be checked without releasing anything. It runs the tag/version
check, install, typecheck, tests and a token check, then stops unless the publish
is explicitly requested:

```bash
gh workflow run verify-npm-token.yml --repo jagaliano/pi-twitterapi.io
gh workflow run release.yml --ref vX.Y.Z                  # dry run
gh workflow run release.yml --ref vX.Y.Z -f publish=true  # the real publish
```

`workflow_dispatch` runs the workflow as it exists at the given ref, so a manual
run has to target a tag that already contains the revision you want. The `v0.1.0`
tag was created before the dry-run mode existed, so dispatching against it
publishes directly.

Once the package exists on npm you can switch to
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) and delete
`NPM_TOKEN`; the workflow works with either.

The `pi-package` keyword makes the published package eligible for the
[pi package gallery](https://pi.dev/packages); the gallery indexes npm, so there
is nothing to submit separately. `.github/workflows/ci.yml` typechecks and tests
every push and pull request.
