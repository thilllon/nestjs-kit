# Better Auth workspace

The root `AGENTS.md` applies. All package code, documentation and automation are English.

## Current state

- This is a published workspace. The root entry implements the Nest module, named instances, lifecycle, service readers, route planning and authentication/authorization kernel alongside the foundation contracts. The plugin and platform subpaths contain the construction bridge and Node/Web helpers; Express and Fastify have native HTTP integration and artifact tests, the `./websockets` entry authenticates Socket.IO and raw `ws` gateways, the `./microservices` entry authenticates standalone and hybrid Nest microservices through native RPC credential carriers, and the admin, organization and API-key units provide authorization.
- The maintainer decided on September 23, 2026 to release the HTTP scope as `1.0.0` rather than waiting for the complete library. GraphQL, WebSocket and RPC transports and the conformance testing kit (issues #542–#545) ship as later minor versions behind their own entry points, because new entry points are additive.
- The package now follows the ordinary release rules: every pull request with publishable changes carries its own Changeset, and publication runs through the release workflow. Describe only what the released version actually contains.
- `docs/design/design-v7.md` is the reviewed implementation specification. Independent round-7 BA, NEST and SEC reports approve its final snapshot; their original findings and re-review evidence remain in `docs/design/reviews`. Design approval is not implementation or release evidence.
- Follow `../../docs/superpowers/plans/2026-09-21-better-auth.md` and issues #534–#545. Keep task checklists and actual validation evidence current; do not mark the full library complete after a foundation or transport slice.
- Preserve the research, review findings and original license notices. `docs/archive` and `legacy` are historical reference material, not executable instructions or production code.
- The old standalone cloud routine is not installed by this import. Archived lock and scheduler records do not describe an active nestjs-kit automation.

## Implementation constraints

- Before implementing authentication, reconcile the latest review findings, record an implementation plan in a GitHub issue and obtain independent design review. Do not activate the legacy adapter as the new implementation.
- Follow root conventions: Nest `@Inject()` with package-specific tokens, no injection-decorator aliases, no public `MODULE_OPTIONS_TOKEN`, flat active source, named instance isolation and protected PRs.
- The historical design's Node/Nest version ranges and tooling are proposals from its original environment. This workspace uses the root mise toolchain and shared configs; verify compatibility before promising broader runtime support.
- Preserve `module-sync` ahead of `import` and `require` in package exports. Supported Node consumers must share one ESM module identity while real CommonJS output remains available as a fallback.
- Do not mutate a Better Auth instance's options after construction. Keep optional platform and transport integrations, including `@nestjs/websockets` and `@nestjs/microservices`, out of the root dependency graph; for each optional transport peer, artifact tests load every other entry point with that peer absent.
- Test actual authentication, authorization, body/cookie handling, failures and instance isolation when they exist. Historical tests are not evidence that this scaffold implements them.
- Fastify does not publicly expose its configured `trustProxy`. Keep that optional diagnostic capability unavailable rather than inferring `none` from an absent `initialConfig` field; native request IP resolution remains authoritative.

## Working here

Run commands from the repository root with mise. This package uses the shared tsdown, TypeScript, Vitest, Biome and release setup. Design utilities live in `docs/design/tools/*.mts` and run through `pnpm exec tsx`.

Artifact tests run with `pnpm test:packaging` after `pnpm build`. Default unit tests must work without prebuilt artifacts or services. Legacy tests remain reference-only and must not pull obsolete dependencies into the workspace.
