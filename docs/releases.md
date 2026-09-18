# Release automation

Packages have independent versions. Changesets is the single versioning engine; Conventional Commits determine release intent. There is no second semantic-release process competing to bump the same files.

Two typed scripts connect those tools: `release-prepare.mts` detects publishable changes and creates the Changesets request; `release-publish.mts` enforces the persisted publication plan and retries only missing versions or tags. Both run through `tsx` and are typechecked with the repository tooling. Their regression tests use `release.test.ts`.

## From a change to npm

1. Merge a PR with a Conventional Commit title into `main`.
2. The release workflow examines commits since `.changeset/release-state.json` and identifies packages with publishable changes. Documentation, tests, and development-only dependency changes do not trigger releases.
3. A breaking change (`!` or `BREAKING CHANGE`) requests a major bump; `feat` requests a minor bump; other publishable changes request a patch. Changesets updates only affected package versions and changelogs.
4. Automation opens or refreshes `automation/releases`. It invokes the reusable CI workflow against that exact commit, then merges only if both its head and the original `main` base still match the validated revisions.
5. When publishing is enabled, the workflow builds both module formats and runs tsdown’s strict publint/attw checks, compares the planned package versions in the release state with npm, and publishes only those planned versions absent from the registry. Published versions receive Git tags and npm provenance.

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

Trusted publishing exchanges the workflow's OIDC identity for publish access; the workflow grants `id-token: write` on a hosted runner. Follow the [npm trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) when configuring the package settings.

All six current package identities already exist on npm. Skip first-publication commands for these packages and configure their trusted publishers. For a future package that does not yet exist, an initial owner-authenticated publication is required before configuring trust: npm's [trust command prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites) require the package to exist. Build, inspect the package archive, and publish the intended first version with public access using the owner's npm authentication. Do not publish placeholder code just to create package settings. Then configure trusted publishing for that new package.

For a future new package only, after its intended release version merges into `main`, use the following pattern with its package name and directory (the Cloudinary paths illustrate the layout; Cloudinary itself is already published):

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter @nestjs-kit/cloudinary build
mise exec -- npm login
cd packages/nestjskit__cloudinary
mise exec -- npm pack --dry-run
mise exec -- npm publish --access public --provenance=false
```

Inspect the dry-run file list before publishing. The explicit `--provenance=false` overrides the package's CI-oriented `publishConfig.provenance` for this local first publication only; later CI publications retain provenance. Run this bootstrap only for an identity that does not yet exist; existing packages use the release workflow. Use your own npm account with package/scope write access and complete its authentication prompts.

In repository Actions settings, allow GitHub Actions to create pull requests. Ensure repository rules permit the release bot's merge after the required checks pass; the workflow does not bypass protections. After all package trusted publishers are configured, set `NPM_PUBLISH_ENABLED=true` and manually run **Release** from the Actions tab, or let the next push to `main` trigger it.

## Retries and maintenance

Run the release workflow with `workflow_dispatch` to retry a failed or newly enabled publication. The registry comparison skips versions already published, so a partially successful run can resume. Publication uses the immutable validated commit, and a retry without a new version PR still runs full CI. Pending releases persist by package and version; the development placeholder `0.0.0` is never published. A package with a pending release must be explicitly retired before it can be deleted or made private. Investigate authentication or build failures before retrying; never replace an existing npm version.

Dependabot groups npm and GitHub Actions version updates into one weekly multi-ecosystem PR. GitHub's security-update handling is separate and may create additional PRs; security updates are grouped within each ecosystem where supported.

The owner handles any retirement or deletion of `@nestjs-tools/*` separately. This automation publishes only the current workspace packages.
