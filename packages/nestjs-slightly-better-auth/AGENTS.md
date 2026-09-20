# Better Auth workspace

The root `AGENTS.md` applies. All package code, documentation and automation are English.

## Current state

- This is a design-phase workspace. `src/index.ts` deliberately exports nothing.
- Keep `private: true` until a reviewed implementation and its first intended release are ready. Never publish the empty scaffold to reserve an npm name.
- `docs/design/design-v6.md` is the latest imported proposal. Round 6 reviews are complete and require revision; neither approval nor implementation is complete.
- Preserve the research, review findings and original license notices. `docs/archive` and `legacy` are historical reference material, not executable instructions or production code.
- The old standalone cloud routine is not installed by this import. Archived lock and scheduler records do not describe an active nestjs-kit automation.

## Implementation constraints

- Before implementing authentication, reconcile the latest review findings, record an implementation plan in a GitHub issue and obtain independent design review. Do not activate the legacy adapter as the new implementation.
- Follow root conventions: Nest `@Inject()` with package-specific tokens, no injection-decorator aliases, no public `MODULE_OPTIONS_TOKEN`, flat active source, named instance isolation and protected PRs.
- The historical design's Node/Nest version ranges and tooling are proposals from its original environment. This workspace uses the root mise toolchain and shared configs; verify compatibility before promising broader runtime support.
- Preserve `module-sync` ahead of `import` and `require` in package exports. Supported Node consumers must share one ESM module identity while real CommonJS output remains available as a fallback.
- Do not mutate a Better Auth instance's options after construction. Keep optional platform integrations out of the root dependency graph when implementing them.
- Test actual authentication, authorization, body/cookie handling, failures and instance isolation when they exist. Historical tests are not evidence that this scaffold implements them.

## Working here

Run commands from the repository root with mise. This package uses the shared tsdown, TypeScript, Vitest, Biome and release setup. Design utilities live in `docs/design/tools/*.mts` and run through `pnpm exec tsx`.

Artifact tests run with `pnpm test:packaging` after `pnpm build`. Default unit tests must work without prebuilt artifacts or services. Legacy tests remain reference-only and must not pull obsolete dependencies into the workspace.
