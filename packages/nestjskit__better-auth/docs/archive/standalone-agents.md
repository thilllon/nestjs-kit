> Historical snapshot from the standalone repository. These are not active
> instructions in nestjs-kit; follow the repository and package AGENTS.md instead.

# Agent Instructions

## What this repository is

`nestjs-slightly-better-auth` is being rewritten from scratch as a NestJS integration for
better-auth. The design comes first: it lives in `docs/design`, three adversarial
reviewers criticize each version, and no library code is written until they approve.
`docs/design/README.md` says which version is current and where the review stands.

- `src/` holds the new library. Today it exports nothing.
- `legacy/` is the old code, a copy of `@thallesp/nestjs-better-auth` v2.4.0. No tool
  reads it (biome, tsc, vitest and tsdown all skip it) and its dependencies are not
  installed. It stays as a reference for behavior worth porting. The branch
  `legacy/thallesp-port` has the same code plus the unfinished edits from 2026-03.

## Autopilot

An hourly cloud routine builds this project without the owner watching: it follows
`docs/autopilot/PROCEDURE.md`, keeps its place in `docs/autopilot/state.json` (which also
holds a lock, so two runs never work at once) and writes `docs/autopilot/log.md`. A local
session that changes the same files should take the lock the same way first, or leave the
work to the routine.

## Pushing to `main`

The owner's standing instruction: commit each meaningful milestone and push it to
`main` right away. No pull request is needed for the owner's or an agent's own work.
A pull request is for outside contributions. Commit messages carry no `Co-Authored-By`
trailer.

Before every push, the full gate must pass:

```sh
mise exec -- pnpm check    # build (with publint and attw), then lint, typecheck and tests
```

lefthook runs the same command as a pre-push hook, and biome plus `tsc` as a pre-commit
hook. After pushing, confirm that CI and Release are green for the pushed commit:

```sh
gh run list --commit "$(git rev-parse HEAD)" --event push
```

An empty list means the runs have not started yet, so check again. Without
`--event push` the list can show only "Dependabot Updates" runs, which also belong to
`main`.

## Releasing

Releases go to npm from the Release workflow (`.github/workflows/release.yml`), which
runs on every push to `main`. It follows the pipeline of `thilllon/pixid` (changesets,
npm trusted publishing over OIDC with no `NPM_TOKEN` secret, a toolchain pinned by
`mise.toml`, no caches), with one hardening step pixid does not have yet: the work is
split into jobs so that the one that can publish runs no build or test code.

| Job           | Permissions             | What it does                                                                                                                          |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `select-mode` | read                    | Decides: `version` when changesets are pending, `publish` when `package.json` carries a version that is not on npm, `none` otherwise. |
| `version`     | contents, pull requests | Opens or updates the "Version Packages" pull request.                                                                                 |
| `pack`        | read                    | Runs `pnpm check`, then packs the tarball.                                                                                            |
| `publish`     | contents, OIDC          | Publishes that tarball and pushes the tag `v<version>`.                                                                               |

To ship a change to npm with the push that contains it:

```sh
# patch, minor or major. The interactive `pnpm changeset` cannot run without a terminal.
mise exec -- pnpm changeset add --patch nestjs-slightly-better-auth -m "Describe the change"
mise exec -- pnpm bump    # changeset version: bumps package.json, writes CHANGELOG.md
git add --all && git commit && git push origin main
```

A push that does not change the version publishes nothing, so docs and CI changes are
safe to push at any time.

If a changeset reaches `main` without `pnpm bump` (a merged pull request, for example),
the workflow opens a "Version Packages" pull request instead; merging it publishes.

CI fails a pull request that changes the package without a changeset. Only files that
change the tarball count (`changedFilePatterns` in `.changeset/config.json`: `src/`,
`package.json`, the build configs, `README.md`, `LICENSE`), so docs, tests and CI need
none. A change to those files that must not be released gets
`pnpm changeset add --empty`. The Release workflow ignores empty changesets, so one on
`main` never holds back a bumped version.

The Release workflow is expected to pass on every push to `main`. Any failure is a real
problem. The split jobs have not published on GitHub yet, so watch the first release
that goes through them.

### First publish

npm can only attach a trusted publisher to a package that already exists, so the first
version is published by hand, once. Until then the Release workflow stops early with a
warning instead of failing. The owner runs:

```sh
npm login
mise exec -- pnpm check
mise exec -- pnpm pack                                   # writes nestjs-slightly-better-auth-<version>.tgz
npm publish nestjs-slightly-better-auth-<version>.tgz    # npm handles the browser or passkey 2FA
npm trust github nestjs-slightly-better-auth --file release.yml --repo thilllon/nestjs-slightly-better-auth --allow-publish
npm access set mfa=publish nestjs-slightly-better-auth   # "Require two-factor authentication and disallow tokens"
npm token list                                           # revoke leftover read-write tokens: npm token revoke <id>
git tag v<version> && git push origin v<version>
```

From then on only the Release workflow (OIDC) or an interactive 2FA publish can release
this package; no access token can. Once the `v<version>` tag exists, the workflow treats
a registry 404 as a fault and fails, instead of skipping the release.

The trusted publisher is bound to the workflow file name `release.yml` and to this
repository name, so renaming either one breaks publishing until the publisher is
registered again on npmjs.com.

While the GitHub repository is private, npm publishes without a provenance attestation
(pnpm logs "Skipped setting provenance"). Provenance starts on its own once the
repository is public. At that point, also create a GitHub environment that only `main`
can use and pass `--env <name>` to `npm trust`, because a trusted publisher is not bound
to a branch.

## Development

The toolchain is pinned by `mise.toml`. Prefix commands with `mise exec --` so the
pinned Node.js and pnpm are used.

- Build: `tsdown`, pinned exactly together with the rolldown it bundles. It emits
  `.mjs`/`.cjs` with `.d.mts`/`.d.cts` and runs publint and attw on the result. The
  `exports` map in `package.json` is written by hand because it needs `module-sync`
  first, so `import` and `require` load the same ESM build.
- Types: `pnpm typecheck` (`tsc --noEmit`). A tsdown build succeeds despite type errors,
  so this check is not optional. TypeScript stays on 6.x: TypeScript 7 dropped the
  classic compiler API, and the declaration generator's TypeScript 7 path (`tsgo`) is
  still experimental.
- Tests: `vitest run` on Vite 8. `tests/packaging.test.ts` reads `dist/`, so build first
  (`pnpm check` does).
- Lint and format: biome. `pnpm lint` is `biome ci`; `pnpm format` writes the fixes.
- pnpm 11 runs a dependency's install script only when `pnpm-workspace.yaml` allows it,
  and refuses a package version published less than a day ago. When the newest release
  of a tool is refused, pin the one before it instead of adding an exclusion.
- Dependabot opens at most two grouped pull requests a week per ecosystem and touches
  devDependencies and workflow refs only. The ranges that ship (`dependencies`,
  `peerDependencies`) are changed by hand, with a changeset. Its pull requests are merged
  by hand: auto-merge needs branch protection, which a private repository on the free
  plan does not have.
- Dependabot does not know about `mise.toml` or the `packageManager` field. The Node.js
  and pnpm pins are updated by hand, and the pnpm version must be the same in both: CI
  installs pnpm from `packageManager`, Release from `mise.toml`, and pnpm switches itself
  to the `packageManager` version when they differ. `tests/packaging.test.ts` fails when
  they drift.
