---
reviewer: NEST
round: 7
reviewed: design-v7.md
snapshot_sha256: 88bf9b74641eafaf138b07b5b52fc056096a6335a71864aa1fdbb88389bb45ea
verdict: approve
blockers: 0
majors: 0
minors: 2
prior_unresolved: []
---

# Round 7 review: NEST

**Verdict: approve the Nest design, with two nonblocking specification corrections.** This
verdict applies only to the snapshot above and this review's Nest scope. It does not approve an
implementation, publication, the complete cross-review security gate, or unexecuted conformance
tests. The SEC review owns the direct-call origin/forwarding findings, including the consequence
for an inheriting field whose plan forwards cookies; this report does not duplicate them.

Reviewed the root and package `AGENTS.md`, `reviews/round-6-NEST.md`, the relevant v7 public
contracts and their validation/lifecycle/test counterparts, and the original
`research/nest-di.md` and `research/nest-platform.md`. All design line references below refer to
the recorded SHA-256 snapshot, not a subsequent revision.

## Round-6 closure assessment

| Original ID | Status                                       | Evidence and remaining boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEST-r6-01  | Closed                                       | B16 at `design-v7.md:3326` explicitly separates global reach from explicit reach. A global guard suffices for the former; explicit reach needs both local enhancers. B31 (`:3341`), §5.7 (`:3459`), ADR-40 (`:6967`) and the new regression row (`:6172`) agree. This stops the original bare-guard gateway/hybrid failure. The stale exported `GuardReach` comment is separately reported below as a minor consistency defect.                                                                                                                                                  |
| NEST-r6-02  | Closed for the reported param-reader failure | §7.8 (`:4135`) gives readers and guards a shared surfaced-error record, stable configuration-error keys that exclude list indices/fresh Error identities, and intrinsic repeats. The lineage-only path gives param factories a carrier even without field interceptors. §13.4 (`:5649`) and `T-internal-error-logged-once` (`:6173`) add the 20-item assertion. Installed Nest 12.0.3 still skips logging `IntrinsicException`, verified below. The new service-without-scope test ambiguity is a separate minor finding, not a reopening of the original param-reader scenario. |
| NEST-r6-03  | Closed                                       | `BetterAuthService.getSession()` at `:692-693` and §7.8 item 5 (`:4132`) distinguish authenticated wrong-kind readings from absent/no-identity. `SESSION_REQUIRED` belongs to the session projection; core need not name a principal kind. §7.8 service rules/advice (`:4150`, `:4152`) and the HTTP regression (`:6174`) cover the service call that B15 cannot see.                                                                                                                                                                                                            |
| NEST-r6-04  | Closed                                       | §9.2 (`:4497`) now examines compiled accepted kinds across every instance in the schema, including kinds contributed by requirements/defaults. The `:6174` regression explicitly uses a default-instance nested reader beneath a machine-instance entry point and widening without `@AcceptPrincipals`. This matches the population the instance-blind inherited lookup reads.                                                                                                                                                                                                   |

The cross-instance advice is implementable without widening `BootAdviceContext.handlers` beyond
its documented instance boundary (`:1939-1940`): the GraphQL transport already enumerates all schema
handlers during `validate`, has `TransportValidationContext.planOf` (`:2469`), and validation
precedes advice collection (`:3452`). It can retain the compiled schema summary on its app-owned
transport instance and use that summary in advice. It must not implement the new warning by
looking only at the current per-instance `ctx.handlers` or `ctx.sources`.

## New findings

### NEST-r7-01 — Minor: `GuardReach` still defines the old global coverage condition

**Contract:** `design-v7.md:2483-2485` says a `global` claim is covered when the application's
global enhancers include both `BetterAuthGuard` and `BetterAuthScopeInterceptor`. B16 (`:3326`),
B31 (`:3341`) and the new normative test (`:6172`) instead require only the guard for global
reach, with missing global scope producing a warning.

**Scenario:** an application has `globalGuard: true`, `globalScope: false` and an ordinary
required HTTP route. Following B16, boot succeeds with `W_NO_GLOBAL_SCOPE`; following the
exported transport contract, the same claim is uncovered. An implementer using that contract
for coverage can reintroduce the exact global opt-out regression that the round-6 correction
was meant to avoid. This is minor because the central rule and its explicit regression are
now unambiguous; the original explicit-reach failure is closed.

**Fix:** define `global` as the reach of application global enhancers, then refer to B16 for
coverage, or state the guard-only coverage condition and B31 scope warning directly. Keep
explicit reach's requirement for both local enhancers. Do not change the new B16 split.

**Test:** retain `:6172`'s global-scope-off success and explicit-bare-guard failure. A
documentation consistency review must include the exported `GuardReach` comment as well as
B16/B31/ADR-40.

**Nest evidence:** installed `@nestjs/core` 12.0.3
`guards/guards-context-creator.js:52-66` and
`interceptors/interceptors-context-creator.js:51-65` obtain their global metadata independently.
Having a global guard does not instantiate or imply a corresponding interceptor.

### NEST-r7-02 — Minor: the new service-reader conformance row requires request context that the service does not have

**Contracts:** the new `T-internal-error-logged-once` row (`design-v7.md:6173`) repeats the
20-item session-reader case with `getSession()` in the resolver body, "with and without field
interceptors." §7.8 (`:4150`) explicitly says a field-resolver service call without field
interceptors has no handler scope and throws `NO_AUTH_SCOPE`. The deduplication paragraph
(`:4135`) permits one-invocation logging where a scope-less reader exposes no carrier. The
service's zero-argument `getSession()` signature (`:693`) provides no execution context.

**Scenario:** an API-key query returns 20 objects, and the nested field body calls
`await service.getSession()` with no field interceptors. The service cannot reach the
authenticated reading or project it: its specified outcome is `NO_AUTH_SCOPE`, before the
`SESSION_REQUIRED` comparison. It also has no invocation/carrier argument from which to find
the deduplication record, so 20 fresh configuration errors can produce 20 ERROR entries. The
new combined test row cannot simultaneously satisfy this service contract and its stated
one-ERROR assertion. A parameter decorator in the same configuration is different: Nest
passes its factory the current invocation arguments, so the lineage-only remedy works.

**Fix:** split the test matrix. With a handler scope, `getSession()` mismatches must produce
`SESSION_REQUIRED` and one log per request. Without a scope, service readers must produce
`NO_AUTH_SCOPE`; explicitly document that no request-level deduplication is promised when the
service has no carrier. Keep both scope and lineage-only one-log cases for param decorators.
If one-log service failures without field interceptors are intended instead, first specify
the additional context propagation mechanism and its lifetime; do not silently reuse a root
scope or process-wide error record.

**Test:** assert the distinct reasons in the two service cases; assert the supported logging
bound separately. A second request must remain observable. Retain the 20-item param-reader
cases under both enhancer configurations.

**Nest evidence:** installed `@nestjs/core` 12.0.3
`helpers/external-context-creator.js:58-80` installs interceptors only when enabled and invokes
parameter extraction inside their chain; `:143-150` supplies current invocation parameters to
the extraction functions. `interceptors/interceptors-consumer.js:7-22` immediately calls the
handler with no interceptors and binds each enabled step's asynchronous context. The inline
probe below confirms that the completed root interceptor does not provide a scope to a later
unintercepted invocation. `exceptions/external-exception-filter.js:4-9` logs every fresh
non-intrinsic Error and then rethrows it.

## Current framework checks and evidence boundaries

The installed framework is `@nestjs/core`/`@nestjs/common` **12.0.3** (their local
`package.json:3`). Current probes ran with **Node 24.21.0** through `mise exec -- node`, using
the installed `rxjs` 7.8.2. They created no package implementation and wrote no scratch files.
An initial probe omitted `reflect-metadata` and stopped during Nest import; the corrected run
imported it first and completed. No Nest 11, GraphQL-driver or Better Auth end-to-end run is
claimed here. The historical major/version evidence remains historical.

The corrected inline probe instantiated the installed `InterceptorsConsumer`, wrapped its
root invocation in the §7.5 `new Observable(sub => als.run(..., () =>
next.handle().subscribe(sub)))` pattern, awaited `lastValueFrom`, then called another
invocation with no interceptors. A separate loop called the installed
`ExternalExceptionFilter.catch` with one plain Error followed by 19 `IntrinsicException`
subclasses, and another with 20 fresh plain Errors. Its output was:

```text
root {"inScope":true}
after-root {"inScope":false}
nested-without-interceptors {"inScope":false}
20-errors-with-intrinsic-repeats 1
20-unscoped-fresh-errors 20
```

Additional source checks:

- Direct Nest injection is compatible with the new string helpers: installed
  `@nestjs/common/decorators/core/inject.decorator.js:32-43` records the explicit token as a
  self-declared dependency; `@nestjs/core/injector/module.js:279-290` implements `useExisting`
  as an alias injecting that exact token. V7 §2.2.8/§2.3 supplies stable default strings and
  named suffixes, keeps async aliases in extras, and hides `MODULE_OPTIONS_TOKEN`. Active API
  examples use `@Inject` directly; no injection-wrapper export remains.
- Structural scope creation (`design-v7.md:2320-2325`, `:2533`, `:3973-3985`) correctly avoids
  eager credential-dependent getters. `InvocationLineage.assertReadable` (`:2451-2455`) is
  carried with the reading and receives each reader's own arguments (`:4117`, `:4123`), so a
  parameter factory without DI can still validate an inherited authenticated read. Public and
  no-identity reads remain structural. The specified stale-request, public-unrecognized and
  sensitive-direct-call cases at `:6176-6177` remain implementation gates.
- The SEC finding's inheriting/form consequence must preserve this separation: require a guard
  for forwarding inherit plans and perform the form check before their early return, while
  keeping their principal lookup inherited and doing no additional principal-source I/O.
  Ordinary inheriting field resolvers still require neither an independent principal
  resolution nor method-level access metadata. The SEC review owns that correction.

The original research supports the broader Nest behavior: `research/nest-di.md` §3.4 (guard
reach and field enhancers), §5 (error delivery), §6.4 (lifecycle), §7 (request identity/ALS),
§8.4 (explicit tokens and dual-load identities), and §9 (testing overrides). No contrary new
Nest lifecycle, metadata or injection behavior was found within this review's changed surface.

No production/design source, package identity, dependency, issue, PR or commit was changed by
this review. The two minor corrections should be included in the author's next snapshot and
checked again before the design PR is finalized.

## Bounded rereview of the amended snapshot

Reviewed SHA-256:
`c0cebe751426440ee8ede6bbf8fed3fb1d8b4a2fc4282b548a5696f139004308`.
The initial findings and their original line references above are preserved. References in
this section belong to the amended snapshot.

**Current verdict: approve the Nest design on this exact snapshot.** NEST-r7-01 and
NEST-r7-02 are closed; the four NEST-r6 closures remain intact. No new blocking Nest issue
was found in this bounded rereview. This is design approval only, not evidence that an
implementation, its conformance matrix, or a production release has passed.

| Item                                                       | Status and amended evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NEST-r7-01                                                 | Closed. `GuardReach` at `design-v7.md:2485-2488` now requires only the global guard for global coverage, explicitly delegates missing scope to B31, and retains both local enhancers for explicit reach. B16 (`:3329`), B31 (`:3344`) and the coverage regression (`:6178`) agree.                                                                                                                                                                                                                                                                                                                                                                                                   |
| NEST-r7-02                                                 | Closed. §7.8 (`:4139`) explicitly distinguishes scoped/argument-bearing readers from a zero-argument unscoped service, which throws `NO_AUTH_SCOPE` before projection and cannot deduplicate by request. §13.4 (`:5655`) qualifies its logging guarantee accordingly. The revised regression (`:6179`) asserts `SESSION_REQUIRED`/one request log with a service scope, `NO_AUTH_SCOPE`/20 fresh-error logs without field interceptors, and param-reader deduplication through either a scope or lineage arguments. No completed-root scope or global suppression is introduced.                                                                                                     |
| Inherited forwarding field, Nest consequences of SEC-r7-01 | Correct in the operative contracts. `RoutePlan` (`:612`) distinguishes principal I/O from form enforcement. The guard (`:3775-3796`) checks enclosing lineage first, returns immediately only for a non-form inherited plan, and otherwise performs the enforcing form check before returning without principal resolution or an own reading. B16 (`:3329`) no longer covers inherited form plans by access alone; the GraphQL claim explanation (`:4509`) explicitly requires guard reach for them. §7.10 (`:4215-4223`) and the regression (`:6194`) retain the inherited identity for trusted requests and require coverage failure when field guards cannot reach the form plan. |

The ordinary non-form inherited path keeps its existing structural enclosure check, nearest
enclosing reading and zero additional principal-source I/O. The form path does not turn a
nested field into an independent required/optional principal plan. It may perform origin
work, including the already specified trusted-origin callback, before letting the field run.
The distinction is consistent with Nest's guard-before-interceptor/handler ordering already
verified in the initial review.

One nonblocking editorial integration note remains under the SEC correction: §9.2 (`:4499`)
still describes inherited field guards as returning immediately with no I/O, and ADR-55
(`:7200`, `:7203`) / ADR-56 (`:7211`, `:7214`) retain their older unconditional inherited
early-return/no-coverage wording. Qualify those summaries for non-form mode, or append the
round-7 amendment to the ADRs. The corrected central guard flow, `RoutePlan`, B16, GraphQL
coverage paragraph and regressions already determine the intended behavior; this note does
not reopen either NEST-r7 finding or duplicate SEC-r7-01.

This pass checked only the amended contracts and their direct consequences. No framework
behavior changed, so the initial installed-Nest source checks and inline probes were not
repeated. The amended document's hash was rechecked after reading. Only this review report
was edited.

## Final snapshot confirmation

Final reviewed SHA-256:
`a653719b8a48ff049b9c47ef9cf9a03d845948dab0314e083ee350041706175b`.

**Final Nest verdict: approve. No open Nest findings remain.** The design approval for the
preceding amended snapshot carries forward to this exact final snapshot; NEST-r7-01 and
NEST-r7-02 remain closed, as do all four round-6 Nest findings.

The bounded final check verified U10 (`design-v7.md:1814`), the inherited-field explanation
in §9.2 (`:4499`), ADR-55's heading/decision (`:7200`, `:7203`) and ADR-56's heading/decision
(`:7211`, `:7214`). Each now distinguishes ordinary inherited early return from the declared
form check. Forwarding inherit plans require guard coverage and complete that check before
returning with the enclosing reading; they neither resolve nor record another principal.
This closes the preceding editorial integration note and matches the already approved
operative guard flow and B16. No further framework probe or full design audit was warranted
by these summary edits.

This remains approval of the Nest design only. Implementation, compatibility/conformance
execution, complete cross-review approval and release readiness require their own evidence.
The historical findings, counts and initial snapshot metadata above are retained as the
review record; the current status is this final confirmation.
