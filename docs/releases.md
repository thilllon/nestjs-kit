# Release automation

Packages have independent versions. Changesets is the single versioning engine; Conventional Commits determine release intent. There is no second semantic-release process competing to bump the same files.

`release-prepare.mts` connects Conventional Commit analysis to Changesets. It runs through `tsx` and keeps only a source-commit checkpoint in `.changeset/release-state.json` so changes are versioned once. Publication uses the native `changeset publish` command, which detects this pnpm workspace and delegates to `pnpm publish`. No separate publisher or duplicate publication inventory is maintained. Regression tests exercise both preparation and native publishing against an isolated local registry.

## From a change to npm

1. Merge a PR with a Conventional Commit title into `main`.
2. The release workflow examines commits since `.changeset/release-state.json` and identifies packages with publishable changes. Documentation, tests, and development-only dependency changes do not trigger releases.
3. A breaking change (`!` or `BREAKING CHANGE`) requests a major bump; `feat` requests a minor bump; other publishable changes request a patch. Changesets updates only affected package versions and changelogs.
4. Automation opens or refreshes `automation/releases`. It invokes the reusable CI workflow against that exact commit, then merges only if both its head and the original `main` base still match the validated revisions.
5. When publishing is enabled, the workflow builds both module formats and runs tsdown’s strict publint/attw checks. `pnpm release:publish` runs Changesets, which compares each public package's current version with npm and publishes only missing versions through pnpm. Existing `publishConfig.provenance` settings retain npm provenance.
6. After publication succeeds, `changeset git-tag` creates any missing current-version tags. The workflow pushes tags explicitly without pushing a branch.

Unchanged packages keep their versions. A runtime dependency update can trigger a release for its consuming package. Repository maintenance alone does not bump every package. Changes to the shared TypeScript and tsdown build configurations affect all public packages. Test-only configuration and fixtures do not trigger releases.

An explicit changeset can request a deliberate release, including a coordinated major release. Changesets combines that request with automatically detected changes into one bump per package; it does not apply both bumps sequentially.

## One-time owner setup

Publishing is disabled until the repository Actions variable `NPM_PUBLISH_ENABLED` is exactly `true`. Version PRs can still run while this gate is disabled, and changelogs accumulate pending changes.

For each npm package, configure a GitHub Actions trusted publisher using:

| Setting           | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| Owner             | `thilllon`                                                |
| Repository        | `nestjs-kit`                                              |
| Workflow filename | `release.yml`                                             |
| Environment       | Leave empty; the workflow does not specify an environment |
| Permission        | Allow publishing                                          |

Trusted publishing exchanges the workflow's OIDC identity for publish access; the workflow grants `id-token: write` on a hosted runner. pnpm 12 implements publication natively, including npm's package-scoped [OIDC token exchange](https://github.com/pnpm/pnpm/blob/v12.4.2/pnpm/crates/publish/src/oidc/auth_token.rs). Follow the [npm trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) when configuring the package settings.

The six established package identities already exist on npm; skip first-publication commands for them. `@nestjs-kit/nodemailer` is new and awaits its first publication. Its checked-in `0.0.0` is a development placeholder, and its explicit major changeset requests `1.0.0`. Wait for that version to merge before publishing.

For a new package that does not yet exist, an initial owner-authenticated publication is required before configuring trust: npm's [trust command prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites) require the package to exist. Build, inspect the package archive, and publish the intended first version with public access using the owner's npm authentication. Do not publish placeholder code just to create package settings. Then configure trusted publishing for that new package.

For the new Nodemailer package only, after its intended release version merges into `main`, use:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter @nestjs-kit/nodemailer build
mise exec -- pnpm login
cd packages/nestjskit__nodemailer
mise exec -- pnpm pack --out /tmp/nestjs-kit-nodemailer.tgz
tar -tzf /tmp/nestjs-kit-nodemailer.tgz
mise exec -- pnpm publish --access public --provenance=false
```

Inspect the archive file list before publishing. The explicit `--provenance=false` overrides the package's CI-oriented `publishConfig.provenance` for this local first publication only; later CI publications retain provenance. Run this bootstrap only for an identity that does not yet exist; existing packages use the release workflow. Use your own npm account with package/scope write access and complete its authentication prompts.

In repository Actions settings, allow GitHub Actions to create pull requests. Ensure repository rules permit the release bot's merge after the required checks pass; the workflow does not bypass protections. After all package trusted publishers are configured, set `NPM_PUBLISH_ENABLED=true` and manually run **Release** from the Actions tab, or let the next push to `main` trigger it.

## Retries and maintenance

Changesets skips versions already present on npm, so a partial publication can resume without uploading them again. After all packages succeed, the separate native `git-tag` step repairs missing public-package tags; `changeset publish` alone does not repair tags for already-published public versions.

For a failed publication or tag push, rerun the failed job in the **original Release workflow run**. Its checkout remains pinned to the validated commit, including the tree comparison. Native `git-tag` uses the current checkout for missing tags and leaves existing tags unchanged; it does not reconstruct the publication commit from registry `gitHead`. Running it on a later checkout can tag the wrong revision. Use a new `workflow_dispatch` when enabling publication or intentionally releasing the latest validated main revision, not to repair an older release's tags.

`pnpm exec changeset publish-plan` inspects the native publication plan without uploading packages. `pnpm release:publish` is the actual publication command; the `NPM_PUBLISH_ENABLED` gate belongs to GitHub Actions, not this local command. Keep unfinished workspace packages `private: true` until their first intended release is ready: native Changesets considers every public package version absent from the registry, including new packages. Do not merge placeholder public packages expecting a separate pending list to hide them.

See the upstream [Changesets command documentation](https://github.com/changesets/changesets/blob/main/docs/command-line-options.md#publish) and [pnpm publish documentation](https://pnpm.io/cli/publish) for the maintained behavior. Investigate authentication or build failures before retrying; never replace an existing npm version.

Dependabot groups npm and GitHub Actions version updates into one weekly multi-ecosystem PR. GitHub's security-update handling is separate and may create additional PRs; security updates are grouped within each ecosystem where supported.

The owner handles any retirement or deletion of `@nestjs-tools/*` separately. This automation publishes only the current workspace packages.
