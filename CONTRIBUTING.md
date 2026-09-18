# Contributing

Choose the package you want to improve from the [package directory](README.md#pick-an-integration). For bugs, include the package version, Node.js version, and a minimal reproduction. For changes to public behavior, explain the expected behavior before opening a large pull request.

## Setup

```sh
git clone https://github.com/thilllon/nestjs-kit.git
cd nestjs-kit
mise trust
mise install
mise exec -- pnpm install
```

Use `mise exec --` before commands, or activate mise in your shell. The repository selects the latest Node.js LTS and pins stable pnpm, Lefthook, and Gitleaks. Do not update the lockfile with another package manager.

## Checks

```sh
pnpm lint
pnpm format:check
pnpm check-types
pnpm build
pnpm test
```

Run `pnpm format` to apply formatting. Run a single package's tests with, for example, `pnpm --filter @nestjs-kit/s3 test`. Tests use mocks and should run without cloud credentials or live PostgreSQL. Add focused regression coverage when changing behavior and update the package README when changing its public API.

Lefthook checks lint, formatting, and staged secrets before a commit; before a push, it checks builds and types. Commit messages are checked with commitlint. CI runs the repository checks, including tests, with the same mise toolchain.

## Pull requests and commits

Use a Conventional Commit title so release automation can determine the change type:

- `fix(s3): preserve custom endpoint configuration`
- `feat(cloudinary): support a new upload option`
- `docs: clarify installation`
- `feat(pubnub)!: require the current SDK configuration`

Explain breaking changes in the PR description and migration guide. Prefer one concern per PR and squash merge with the Conventional Commit title. Do not add `Co-Authored-By` trailers.

Package versions and changelogs are maintained by release automation. Do not manually bump versions for ordinary feature or fix PRs. See [releases](docs/releases.md) for how Conventional Commits become package-specific Changesets.

## Repository layout

- `packages/nestjskit__*`: packages published under `@nestjs-kit/*`.
- `packages/nestjs-azure-storage-blob`: the existing Azure npm package.
- `packages/nestjs-drizzle-pg`: the existing Drizzle npm package.
- `.github/workflows`: CI, dependency maintenance, and releases.
- `docs`: migration and maintainer guides.

Keep public exports in each package's `src/index.ts`; avoid importing another package's internal source files. A package must declare the dependencies its consumers need.
