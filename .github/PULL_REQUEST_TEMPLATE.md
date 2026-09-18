## What changed and why?

Describe the user-visible behavior and link the issue (for example, `Closes #123`).

## Validation

- [ ] `pnpm lint` and `pnpm format:check`
- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm build`
- [ ] tsdown package/type validation (included in `pnpm build`)
- [ ] Conventional Commit PR title; breaking changes use `!` or `BREAKING CHANGE:`
- [ ] Public API changes have examples and updated package documentation

See [CONTRIBUTING.md](../CONTRIBUTING.md). Include an explicit Changeset for publishable package changes; documentation, tests and repository-only tooling need none.
