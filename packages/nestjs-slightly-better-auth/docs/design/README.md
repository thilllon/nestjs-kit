# Design workspace

This directory preserves the design and review history of
`nestjs-slightly-better-auth`, now maintained in the `nestjs-kit` monorepo.
The final v7 specification has independent design approval and is the contract the
implementation follows. The package implements its HTTP scope, the consumer testing
helpers and the conformance kits and, through the `./graphql`, `./websockets` and
`./microservices` entries, its GraphQL, WebSocket and RPC transports.

Three reviewers examine Better Auth fidelity, NestJS correctness and SOLID, and
security and operations. Historical designs and research retain their original
assumptions; the [repository instructions](../../../../AGENTS.md) govern current work.

| Path                              | What it is                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `design-v<N>.md`                  | A complete design revision. Version 7 is the reviewed implementation specification.    |
| `ledger.md`                       | Findings, their dispositions, and the related architecture decisions.                  |
| `reviews/round-<N>-<reviewer>.md` | Full reviewer reports, including the original round 7 verdicts and re-review evidence. |
| `v2-parts/` to `v7-parts/`        | Editable sections of the matching authoritative design documents.                      |
| `research/`                       | Nine research reports and their digest, with source citations.                         |
| `tools/prompts.mts`               | Renders review, revision and audit prompts without executing them.                     |
| `tools/splice.mts`                | Replaces a uniquely identified design section with a part file.                        |
| `tools/sync-parts.mts`            | Synchronizes sections or checks that they reproduce the complete design.               |
| `reference/`                      | Archived workflow source that is not executable monorepo automation.                   |

## Status

| Round | Reviewed    | Verdicts                                 | New findings                                                      | Result                                                    |
| ----- | ----------- | ---------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| 1     | v1          | 3 × reject                               | 43 (4 blockers, 19 majors, 20 minors)                             | v2, then an audit closed 34 gaps                          |
| 2     | v2          | 3 × reject                               | 34 (3 blockers, 13 majors, 18 minors) + 1 unresolved              | v3, then an audit closed 31 gaps                          |
| 3     | v3          | 3 × reject                               | 23 (0 blockers, 12 majors, 11 minors) + 3 unresolved              | v4, then an audit closed 23 gaps                          |
| 4     | v4          | 3 × reject                               | 15 (0 blockers, 6 majors, 9 minors), none unresolved              | v5, then an audit closed 16 gaps                          |
| 5     | v5          | BA approve, NEST reject, SEC reject      | 11 (0 blockers, 5 majors, 6 minors), none unresolved              | v6, then an audit closed 16 gaps                          |
| 6     | v6          | 3 × reject                               | 10 (0 blockers, 6 majors, 4 minors), none unresolved from round 5 | Closed by v7 and independent round-7 review               |
| 7     | v7, amended | BA, NEST and SEC approve after re-review | 5 findings, all closed (2 majors, 3 minors)                       | Reviewed specification; implementation tracked separately |

[Design v7](design-v7.md) is the reviewed specification for
[issue #534](https://github.com/thilllon/nestjs-kit/issues/534).
[Better Auth](reviews/round-7-BA.md), [NestJS](reviews/round-7-NEST.md) and
[security](reviews/round-7-SEC.md) reviewers approved the final snapshot after
closing all ten round-6 findings and all five round-7 findings. The reviewed
SHA-256 is `a653719b8a48ff049b9c47ef9cf9a03d845948dab0314e083ee350041706175b`.
The design's draft-time pending-review notes are preserved; these final reports
and the ledger record its current review status.

The [implementation plan](../../../../docs/superpowers/plans/2026-09-21-better-auth.md)
covers all 13 entry points in linked issues #535–#545. No implementation or
publication is claimed by the design approval. Original findings and their
re-review evidence remain available; the complete library remains the scope.

The owner decided on September 17, 2026 that product questions take their recommended
option, including questions added by later reviews. That decision resolves product
choices, not reviewers' correctness or security findings.

The standalone repository's hourly routine, lock state and direct-to-main procedure
are historical records. They are not enabled by this import. Further design work
must use the monorepo's issue and protected pull request workflow, and implementation
must follow a reviewed design. No design review or implementation is started by the
commands below.

## Working with the documents

Run these commands from the monorepo root after installing its dependencies:

```sh
# Render prompts for a future revision when an implementation finding requires one.
mise exec -- pnpm exec tsx packages/nestjs-slightly-better-auth/docs/design/tools/prompts.mts --round 7 --from 7 --to 8 --out /tmp/nsba/prompts

# Check that all v7 sections reproduce the authoritative document.
mise exec -- pnpm exec tsx packages/nestjs-slightly-better-auth/docs/design/tools/sync-parts.mts design-v7.md v7-parts --check

# Replace one section after editing its corresponding part, then resynchronize.
mise exec -- pnpm exec tsx packages/nestjs-slightly-better-auth/docs/design/tools/splice.mts design-v7.md '## 3. Architecture' '## 4. Extension points' v7-parts/p03-s3.md
mise exec -- pnpm exec tsx packages/nestjs-slightly-better-auth/docs/design/tools/sync-parts.mts design-v7.md v7-parts
```

The section tools resolve relative document and part paths from this design directory,
using their own file location. The prompt renderer locates this package independently
of the current working directory; relative `--out` and `--scratch` paths resolve from
the package directory. Absolute paths work for all three tools.

## Declarations that differ from the reviewed text

The reviewed v7 text stays unchanged. These published declarations differ from it:

- §2.2.3 `HookMethodDecorator<P>` and `DbHookMethodDecorator<E, Ph>` infer the decorated
  method type `M` and constrain it to `(ctx: AuthHookContext<P>) => unknown` or
  `DatabaseHookMethod<E, Ph>`. The reviewed declarations fix the invariant
  `TypedPropertyDescriptor` type instead, which rejects sound methods with fewer
  parameters or narrower results, such as the one-parameter
  `@BeforeDatabase("user.delete")` hook in §4.5.2.
  The §11.3 and §11.4 hook type guarantees still hold: before-hook bodies are unvalidated,
  update payloads are partial, delete hooks cannot return data, database hooks accept a
  missing endpoint context and multi-path hooks accept the path union
  ([issue #589](https://github.com/thilllon/nestjs-kit/issues/589)).
- §9.2 and `T-stale-context` limit the runtime stale-context check to HTTP operations
  (`isLive`). A GraphQL context function must return a fresh object for every operation and
  every graphql-ws connection; a cached context is a configuration error that the transports
  cannot always detect. The Apollo transport classifies a graphql-ws operation's socket once,
  when the operation first reaches the transport, and keeps that classification for the
  execution's later readers (keyed by its graphql-js variable-values object). A socket that is
  not `OPEN` (`readyState !== 1`) at that point may belong to a connection that closed while
  graphql-ws awaited the operation's context or to an earlier connection that a cached context
  carries; its state cannot tell the two apart. The operation therefore reads no credential of
  that connection: its headers carry only the upgrade request's host metadata, without
  connection parameters, `subscriptionCredentials`, upgrade-request credentials or cookies, and
  its call carries neither the context as its memo key nor a connection for principal reuse. It
  runs anonymously: required operations answer the unauthenticated denial, public and optional
  ones run without a principal, and nothing is logged at ERROR. The origin check still evaluates
  that connection's handshake, which grants no credential. A socket that closes after its
  operation started keeps that operation's credentials. A cached context of a closed connection
  authenticates nothing; while the earlier connection is still open, the transport cannot tell a
  cached context from the current one, so the fresh-context rule is mandatory.
  `T-stale-context` runs its cached-context row on connection-shaped legs through
  `invokeConnection`, which resolves after the server observed the close, and accepts the later
  caller's own principal, an anonymous answer or the unauthenticated denial, never the first
  caller's principal, with nothing logged at ERROR. Mercurius socket operations use its
  per-connection `subscription.context` and carry no graphql-ws `extra`, so they are unaffected
  ([issue #625](https://github.com/thilllon/nestjs-kit/issues/625)).

## Paths in historical documents

`BA/` identifies the Better Auth monorepo at v1.7.4; `REF/` identifies
`@thallesp/nestjs-better-auth` at v2.8.0 (commit `99d4a94`). Reports may also cite
standalone repository paths and temporary `tmp-*` experiment directories. Those are
historical citations, not runnable locations. Reproduce an experiment before relying
on its result for a new decision.

Examples inside historical designs may refer to former tool filenames, configuration,
injection decorators, or release procedures. V7 reconciles active implementation
contracts with direct Nest injection, readable token helpers, flat source and root
Node 24/shared tooling; its historical evidence and changelog retain their provenance. Use the current commands above and the
monorepo rules for new work; do not silently treat old proposals as current policy.
