# Release automation

Packages have independent versions. Changesets is the single versioning engine. Explicit Changeset files specify which packages to release and their bump types; Conventional Commits describe changes but do not infer versions.

Publication uses the native `changeset publish` command, which detects this pnpm workspace and delegates to `pnpm publish`. Versioning uses native `changeset version`. No custom release scripts or source checkpoints are needed.

## From a change to npm

1. Include a Changeset in every PR with publishable package changes. Run `pnpm exec changeset`, select affected packages and bump types, and write a user-facing summary. The implementing agent includes this file when doing the work. Documentation, tests and repository-only tooling need no Changeset.
2. Merge the PR with a Conventional Commit title into `main`. The release workflow checks out its immutable event commit. When Changeset files are present, it runs `pnpm exec changeset version`, which consumes them and updates affected versions and changelogs. It refreshes the lockfile and formatting, then checks the staged diff. With no pending Changesets, it creates no version PR.
3. Automation opens or refreshes `automation/releases`. It dispatches CI on that branch, verifies the expected commit and waits for that uniquely identified run to pass. After verifying the CI repository, workflow, commit and successful `Validate` job, it reports that result as a Checks API `Validate` check on the release PR head, linking to the full run. Automation merges only if both its head and the original `main` base still match the validated revisions.
4. A run that merges a version PR never publishes. When publishing is enabled, its merge job dispatches a fresh Release run on `main`. That run prepares from its immutable event SHA, runs full CI, and publishes only if it has no new Changesets to version. It verifies that its preparation base, checkout and workflow event SHA match, as well as the validated tree. If more Changesets arrived meanwhile, it creates another version PR instead.
5. The publishing run builds both module formats and runs tsdown’s strict publint/attw checks. `pnpm release:publish` runs Changesets, which compares each public package's current version with npm and publishes only missing versions through pnpm. Existing `publishConfig.provenance` settings retain npm provenance.
6. After publication succeeds, `changeset git-tag` creates any missing current-version tags. The workflow pushes tags explicitly without pushing a branch.

Use major for breaking public API or runtime requirements, minor for compatible features, and patch for compatible fixes. Include affected packages for runtime dependency and shared build configuration changes. Unchanged packages keep their versions; Changesets may also update internal dependents according to its configuration.

For a coordinated release, name every intended package in a Changeset. Multiple pending Changesets combine into one bump per package using the strongest requested bump; they do not bump the same package sequentially. Do not edit package versions directly.

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

The six established package identities already exist on npm; skip first-publication commands for them. `@nestjs-kit/nodemailer` is new and awaits its first publication. Its first release version, `1.0.0`, has merged into `main`; npm publication still awaits owner authentication. It is temporarily listed in `.changeset/config.json` under `ignore` so the six established packages can publish independently through OIDC. Native Changesets excludes ignored packages from its publish plan and versioning; this is a temporary bootstrap hold, not a permanent release policy.

For a new package that does not yet exist, an initial owner-authenticated publication is required before configuring trust: npm's [trust command prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites) require the package to exist. Build, inspect the package archive, and publish the intended first version with public access using the owner's npm authentication. Do not publish placeholder code just to create package settings. Then configure trusted publishing for that new package. For Nodemailer, verify its first published version and trusted publisher, then remove its temporary `ignore` entry through a checked PR. [Issue #458](https://github.com/thilllon/nestjs-kit/issues/458) tracks these prerequisites and removal.

For the new Nodemailer package only, use its release version checked into `main`:

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

In repository Actions settings, allow GitHub Actions to create pull requests. Ensure repository rules permit the release bot's merge after the required checks pass; the workflow does not bypass protections. After trusted publishers are configured for every non-ignored package, set `NPM_PUBLISH_ENABLED=true` and manually run **Release** from the Actions tab, or let the next push to `main` trigger it.

## Retries and maintenance

Changesets skips versions already present on npm, so a partial publication can resume without uploading them again. After all packages succeed, the separate native `git-tag` step repairs missing public-package tags; `changeset publish` alone does not repair tags for already-published public versions.

For a failed publication or tag push, rerun the failed job in the **original Release workflow run**. Its checkout remains pinned to that publishing run’s event commit, including base/SHA/tree comparisons. Do not rerun the earlier version-PR merge run to repair a failed publication. Native `git-tag` uses the current checkout for missing tags and leaves existing tags unchanged; it does not reconstruct the publication commit from registry `gitHead`. Running it on a later checkout can tag the wrong revision. Use a new `workflow_dispatch` when enabling publication or intentionally releasing the latest validated main revision, not to repair an older release's tags.

`pnpm exec changeset publish-plan` inspects the native publication plan without uploading packages. `pnpm release:publish` is the actual publication command; the `NPM_PUBLISH_ENABLED` gate belongs to GitHub Actions, not this local command. Keep unfinished workspace packages `private: true` until their first intended release is ready: native Changesets considers public package versions absent from the registry, including new packages, except packages explicitly listed in its `ignore` configuration. Do not merge placeholder public packages expecting a separate pending list to hide them.

See the upstream [Changesets command documentation](https://github.com/changesets/changesets/blob/main/docs/command-line-options.md#publish) and [pnpm publish documentation](https://pnpm.io/cli/publish) for the maintained behavior. Investigate authentication or build failures before retrying; never replace an existing npm version.

Dependabot groups npm and GitHub Actions version updates into one weekly multi-ecosystem PR. GitHub's security-update handling is separate and may create additional PRs; security updates are grouped within each ecosystem where supported.

The owner handles any retirement or deletion of `@nestjs-tools/*` separately. This automation publishes only the current workspace packages.

## Protected main branch

All changes reach `main` through squash pull requests with the GitHub Actions `Validate` check passing and all review conversations resolved. Branches must be up to date. No actor bypasses these rules; mandatory reviewer approvals remain zero for solo maintenance. Force pushes and branch deletion are blocked.

Release automation uses `workflow_dispatch`, which [can start a workflow with `GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token). The dispatched branch determines the CI run's commit; CI rejects a mismatched expected SHA before checkout. The same full checks run when retrying publication without a version PR.

GitHub documents that [job checks from dispatched workflows do not satisfy required PR checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated). A green dispatched run alone is therefore insufficient. After the real CI run succeeds, release validation rechecks its repository, CI workflow ID, unique run key, commit SHA and successful `Validate` job. Only then does it create a completed `Validate` check through the [Checks API](https://docs.github.com/en/rest/checks/runs#create-a-check-run), targeting that same SHA and linking to the actual run. Failed, skipped or mismatched validation cannot produce a success report.

The release validation job receives `actions: write` and `checks: write`; it does not check out or execute package code. The merge job additionally receives `actions: write` only to dispatch the fresh publication run when the gate is enabled. No personal token, separate GitHub App or protection bypass is configured. The merge checks the validated PR head, original main base and resulting merged tree. Publication in the fresh run verifies its own event commit and validated tree.

This protected flow was verified by [release PR #497](https://github.com/thilllon/nestjs-kit/pull/497). [Full CI](https://github.com/thilllon/nestjs-kit/actions/runs/35381245044) passed on the exact PR head, and the [release workflow](https://github.com/thilllon/nestjs-kit/actions/runs/35381191397) reported its result and merged through `github-actions[bot]` under the active required-check rules without bypass actors or owner approval. Publication remained gated. The evidence is recorded in [#495](https://github.com/thilllon/nestjs-kit/issues/495) and [#477](https://github.com/thilllon/nestjs-kit/issues/477).

## Provenance source revision

pnpm [records `GITHUB_SHA` as the signed source revision](https://github.com/pnpm/pnpm/blob/v12.4.2/pnpm/crates/publish/src/provenance_gen.rs#L228-L267). Checking out a newly merged version commit inside an older workflow run does not change that event SHA. The separate publication run ensures the signed source revision and the commit used to build the npm archive agree.

Historical releases can retain the earlier mismatch; immutable npm versions and their attestations are not rewritten. [Issue #502](https://github.com/thilllon/nestjs-kit/issues/502) records the evidence and verification of the corrected flow on the next requested major releases.
