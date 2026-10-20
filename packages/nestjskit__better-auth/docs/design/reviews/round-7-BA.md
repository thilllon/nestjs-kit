---
reviewer: BA
round: 7
reviewed: design-v7.md
initial_verdict: reject
verdict: approve
blockers: 0
majors: 0
minors: 0
initial_majors: 1
initial_minors: 1
prior_unresolved: []
---

# Round 7 review: BA (Better Auth fidelity)

Initial verdict: **reject** (0 blockers, 1 major, 1 minor). The three original round-6 BA
findings are closed in their original scope. Two adjacent SDK contracts still
contradict the revised JWT sketch and hook regression requirements.

This is a bounded review of the round-6 BA closures in §4.3.4, §5.4 B19, §7.5,
§7.10, §10.5, §14.5, Q39 and RK1, for
[issue #534](https://github.com/thilllon/nestjs-kit/issues/534). It does not approve
the complete design or claim that the adapter or its planned tests are implemented.
The summary and separate SEC wording were still being finalized during this review.
The reviewed file's recorded SHA-256 was
`88bf9b74641eafaf138b07b5b52fc056096a6335a71864aa1fdbb88389bb45ea`.

## Evidence and verification

- `BA` below means the clean official Better Auth clone at
  `/private/tmp/nsba-implementation/better-auth`, tag `v1.7.5`, commit
  `5468e6bfcdff799848537cf5ad06ebab15aad9dd`. Source paths are relative to
  `packages/better-auth/src/`.
- Runtime probes used the installed `better-auth@1.7.5` and `better-call@1.4.0` in
  `/private/tmp/nsba-implementation/probes`, with Node **24.21.0** through the root
  mise toolchain. They used local memory adapters, synthetic hostnames and generated
  in-memory keys; they made no external service calls.
- I independently reran `sdk-contracts.mts` with plain Node. Its endpoint-runs and
  short-circuit header assertions passed, as did the `require('better-auth')` /
  ESM import identity assertion. This result applies to plain Node, not the `tsx`
  launcher or an unbuilt adapter artifact.
- Additional inline probes exercised dynamic `getJwks`, JWT default claims, and
  native before-hook returns/throws through both `auth.api` and `auth.handler`.
  Their relevant results are recorded below. No implementation files were changed.

## Round-6 closures

| Finding                                                                             | Status     | Evidence and remaining boundary                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BA-r6-01** — boolean origin skip with explicit CSRF false                         | **Closed** | B19 now warns for `skipCSRFCheck` or boolean `skipOriginCheck`, including the previously silent combination. §7.10 defines the shared kernel predicate; §7.5 refers to that exact predicate. Q39 explicitly selects the stricter app-route behavior, and §14.5 names router-allow/kernel-deny and path-array cases as expected divergences. Nonempty path arrays receive the requested informational diagnostic. |
| **BA-r6-02** — nonthrowing before-hook response headers lost when the endpoint runs | **Closed** | §10.5 now distinguishes endpoint execution from short-circuiting, recommends after-hooks for response effects, and forbids restoring discarded headers. RK1 names the accumulator replacement. §14.5 requires native/Nest parity for response cookies and headers across both paths. The native behavior was reproduced on 1.7.5. The separate assertion about _thrown_ errors needs correction under BA-r7-02.  |
| **BA-r6-03** — `new URL('')` for an unset base URL                                  | **Closed** | The sketch checks whether `baseURL` is nonempty before parsing it, derives issuer and audience independently, and raises `JWT_CLAIMS_NOT_CONFIGURED` instead of an accidental `TypeError`. It covers both unset and dynamic configurations and specifies a boot check plus a request fallback. The newly promised successful dynamic configuration encounters a different SDK precondition under BA-r7-01.       |

The source supports these closures:

- [`origin-check.ts:15–49`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/middlewares/origin-check.ts#L15)
  separates the backward-compatibility predicate from unconditional boolean origin
  skipping and path-array matching.
  [`:233–245`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/middlewares/origin-check.ts#L233)
  applies all three early returns. Explicit CSRF false does not cancel the third.
  [`:322–371`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/middlewares/origin-check.ts#L322)
  confirms that cookie-free cross-site navigation can still be rejected by the
  form rule when only the boolean-origin skip is effective. The design's deliberate
  kernel divergence is therefore appropriate; its historical 1.7.0–1.7.4 statement
  remains true on the inspected 1.7.5 source.
- [`dispatch.ts:193–219`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/dispatch.ts#L193)
  accumulates before-hook response headers;
  [`:386–393`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/dispatch.ts#L386)
  returns them on short-circuit;
  [`:426–434`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/dispatch.ts#L426)
  replaces them with endpoint headers before after-hooks run.
- [`create-context.ts:145–150, 189–196`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/context/create-context.ts#L145)
  and [`:285`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/context/create-context.ts#L285)
  confirm the empty shared-context base URL. Avoiding `new URL('')` is necessary.
  This shared context must not be confused with the resolved per-call context below.

## New findings

### BA-r7-01 (major): explicit JWT claims do not make the no-argument JWKS call work with a dynamic base URL

**Sections:** §4.3.4's `this.keys.get(() => r.auth.api.getJwks())`, the following
dynamic-baseURL explanation, and §14.5's `S-jwt-claims` addition.

**Concrete failure.** An application uses
`baseURL: { allowedHosts: ['tenant.example'] }`, with no fallback, and sets
`jwt: { issuer: 'https://issuer.example', audience: 'https://audience.example' }`.
Its principal source supplies those same two values, exactly as the revised sketch
requires. The new claim guard passes. The first uncached JWT verification then
calls `auth.api.getJwks()` with no headers or request and throws a 500 before
reading keys or verifying the token. Every request requiring that read fails;
setting matching claims does not fix it.

**SDK mechanism.**

- [`to-auth-endpoints.ts:34–65`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/to-auth-endpoints.ts#L34)
  requires an input source or configured fallback for an unresolved dynamic context.
  Its no-source/no-fallback branch throws `APIError('INTERNAL_SERVER_ERROR')`.
- [`:92–105`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/to-auth-endpoints.ts#L92)
  performs that resolution for every wrapped API endpoint, including `getJwks`,
  before dispatch. JWKS being a public endpoint does not exempt the call.
- [`context/helpers.ts:210–238`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/context/helpers.ts#L210)
  resolves a clone and sets its `options.baseURL` to the resolved origin.

Native runtime result, with the explicit, distinct issuer/audience above:

| Dynamic configuration                | `getJwks` input                                    | Result                                          |
| ------------------------------------ | -------------------------------------------------- | ----------------------------------------------- |
| No fallback                          | No input                                           | **500**, dynamic base URL could not be resolved |
| No fallback                          | `headers: new Headers({ host: 'tenant.example' })` | Success, one JWK                                |
| `fallback: 'https://tenant.example'` | No input                                           | Success, one JWK                                |
| Same fallback                        | Same host headers                                  | Success, one JWK                                |

The associated explanation that an empty shared `$context.baseURL` means Better
Auth defaults JWT claims to empty strings is also too broad. A second native probe
with **no explicit claims** produced:

| Configuration / direct `signJWT` call        | Shared `$context.baseURL` | Token `iss` / `aud`                                 |
| -------------------------------------------- | ------------------------- | --------------------------------------------------- |
| Unset base URL, host headers supplied        | `''`                      | `''` / `''`                                         |
| Dynamic allowed hosts, host headers supplied | `''`                      | `https://tenant.example` / `https://tenant.example` |

The signing defaults read the **per-call** `options.baseURL`
([`jwt/sign.ts:290–302`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/plugins/jwt/sign.ts#L290)).
HTTP handler contexts can likewise be resolved even when the shared context is
empty ([`auth/base.ts:55–94`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/auth/base.ts#L55)).
Requiring explicit stable claims for this source can remain the intended contract;
it should not be justified by an unconditional empty-claim statement about the SDK.

**Required correction.** Give the JWKS call a supported per-call resolution source,
for example the source request's headers with its host information preserved, or
explicitly require and validate a fallback for this no-argument design. Preserve
the existing scope, credential, cookie and hook semantics when adding headers.
Distinguish the shared boot context from the resolved signing context in the prose.
Do not infer issuer/audience from untrusted token claims.

**Regression test.** Extend `S-jwt-claims` with dynamic configurations both with
and without fallback. With no fallback and explicit distinct matching claims,
mint and verify a real token using a valid host source; assert successful key
retrieval and verification. Keep missing-claim boot/request failures, wrong-claim
401s and real JWKS storage failures separate. Assert that the unamended no-input
JWKS call fails so the fixture cannot accidentally conceal the precondition with
a fallback.

### BA-r7-02 (minor): a throwing before-hook retains response headers on its direct API error

**Sections:** §10.5's before-throws row and closing sentence; §14.5's
`LIB-dispatcher-parity` addition saying that throws lose cookies and headers;
§7.3's `apiErrorSetCookies(e)` consumer.

**Concrete failure.** A native before-hook on `/get-session` sets a cleanup cookie
and throws an `APIError('FORBIDDEN')`. The router's response drops that cookie,
but the direct `auth.api.getSession` caller receives the original error with the
cookie attached through `Symbol.for('better-call:api-error-headers')`. The design's
own session-source catch reads exactly that symbol and can append the cookie to
the caller's sink. A regression that demands cookie loss for all throwing paths
would reject this faithful error forwarding or encourage stripping SDK evidence.

**SDK mechanism.** The installed `better-call@1.4.0` artifact
`dist/middleware.mjs:21–29` attaches a non-enumerable symbol getter returning the
middleware's response headers, then rethrows the same API error. The symbol's
definition is `dist/error.mjs:134`.
[`BA/api/dispatch.ts:183–190`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/dispatch.ts#L183)
rethrows rather than stripping it; execution never reaches the after-hook bridge.

Native runtime results for a hook setting `x-probe` and one cookie:

| Before-hook outcome            | Direct API observation                     | Router observation             |
| ------------------------------ | ------------------------------------------ | ------------------------------ |
| `undefined`, endpoint runs     | Returned headers lack both                 | 200, neither header nor cookie |
| `{ context }`, endpoint runs   | Returned headers lack both                 | 200, neither header nor cookie |
| Short-circuit object           | Returned headers contain both              | 200, both present              |
| Throws `APIError('FORBIDDEN')` | Thrown error's symbol headers contain both | 403, neither present           |

**Required correction.** Say that a thrown before-hook does not deliver its
accumulator through the normal router response or after-hook bridge, while a
thrown API error preserves error-attached headers for direct callers. Retain
§7.3's extraction behavior; do not change the SDK mirror to force blanket loss.

**Regression test.** Split the throwing case into router response, skipped
after-hook/bridge, and direct thrown-error symbol observations. Also assert the
session source's documented cookie extraction for a native before-hook API error.
Continue comparing the same observations for native and Nest-dispatched hooks.

## Initial decision

Q39's recommended option is faithfully applied and needs no new product decision.
The original three round-6 BA findings can be marked closed. Resolve BA-r7-01 and
BA-r7-02 and review the corrected JWT and throwing-hook rows before claiming BA
approval of this revision.

## Re-review of the amended revision

Current verdict: **approve** for this bounded BA review. BA-r7-01 and BA-r7-02
are closed; no unresolved BA findings or new contradictions were found in the
changed seams. The initial rejection, findings and runtime evidence above remain
historical records of the earlier snapshot.

The exact reviewed `design-v7.md` SHA-256 is
`c0cebe751426440ee8ede6bbf8fed3fb1d8b4a2fc4282b548a5696f139004308`, matching the
author's frozen revision. This re-review covers the amended §4.3.4, §10.5 and
§14.5 requirements and their existing `PrincipalRequest`, `AuthHandle` and B20
boundaries. It does not re-review the complete baseline or the separate SEC
form/inheritance changes, and does not claim implementation or execution of the
planned adapter regression tests.

### BA-r7-01 — closed

The JWKS fetch now calls `r.auth.api.getJwks({ headers: r.headers })`. This supplies
the SDK's `pickSource` contract when the existing transport headers carry the
host, and removes the no-source/no-fallback failure reproduced above. The text
explicitly preserves those headers, the existing internal scope, hooks, credentials
and cookie forwarding. A hostless transport requires a validated fallback through
B20; no host is synthesized to conceal missing request context. The source reads
the shared context through `AuthHandle.context()`, which is the API declared in
§4.3.1.

The claim explanation now separates the shared boot context from the resolved
per-call signing context. It accurately records dynamic-host defaults and retains
explicit stable issuer/audience as this source's contract when the shared base URL
is empty. Expected claims are not inferred from bearer-token contents or request
headers. Source-instance cache ownership and alias isolation remain explicit.

The revised `S-jwt-claims` requirements cover dynamic configurations with and
without fallback, distinct matching claims, valid host headers, a deliberately
failing no-input JWKS control, wrong-claim 401s, storage 5xx responses, scope/hook
behavior and per-instance cache isolation. These requirements directly expose the
previously failing scenario rather than relying on an implicit fallback.

Verification used the already passing native runtime controls recorded above and
the unchanged pinned 1.7.5 source:

- [`context/helpers.ts:175–188`](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/context/helpers.ts#L175)
  accepts the supplied host-bearing `Headers` as the resolution source.
- `to-auth-endpoints.ts:34–65, 92–105` and `context/helpers.ts:210–238`, cited in
  BA-r7-01, resolve that source before dispatch and preserve the distinction
  between shared and per-call context.
- `jwt/sign.ts:290–302`, cited above, reads defaults from the per-call options;
  the amended explanation and explicit-claim contract agree with that behavior.

### BA-r7-02 — closed

§10.5 now separates throwing API errors from non-API errors and distinguishes the
normal router response from direct error-attached headers. The dispatcher must
rethrow unchanged, after-hooks and their bridge do not run, and
`apiErrorSetCookies` may consume the preserved symbol headers. The closing prose
repeats that distinction rather than claiming blanket loss.

The revised `LIB-dispatcher-parity` requirements independently assert all four
observations: absent router headers, skipped after-hooks/bridge, preserved direct
API-error symbol headers, and session-source cleanup-cookie forwarding. They keep
the already correct endpoint-runs and later-short-circuit expectations.

These changes match the earlier native runtime table, `better-call@1.4.0`
`dist/middleware.mjs:21–29`, and the unchanged 1.7.5 `dispatch.ts:183–190`. No
new mechanism was introduced that required repeating the previously passing SDK
probes.

### Re-review checks and limit

- Confirmed the frozen design hash above and read the changed sections, their
  regression rows, the `AuthHandle`/header contracts and the B20 fallback rule.
- Rechecked the SDK's host-source selection and dynamic-context resolution
  against the same pinned official source. Reused the recorded native runtime
  evidence; did not rerun the already passing SDK probes.
- Formatted this review file with the repository's Prettier and checked its
  whitespace. No design or implementation files were changed by the reviewer.

The three original round-6 BA closures remain closed. Approval here is the BA
design-review result for the identified amended revision; implementation and its
real consumer/regression validation remain separate gates.

## Approval carried forward to the final snapshot

The final `design-v7.md` SHA-256 is
`a653719b8a48ff049b9c47ef9cf9a03d845948dab0314e083ee350041706175b`.
I confirmed that hash and re-read the approved BA changes in §4.3.4, §10.5 and
their §14.5 regression rows. The request-aware JWKS call, shared/per-call claim
distinction, scope and hostless-fallback requirements, thrown-error header
contract and corresponding regressions remain unchanged in meaning from the
approved snapshot above.

The bounded BA verdict therefore remains **approve**, with BA-r7-01 and BA-r7-02
closed and no new BA findings. The separate U10, §9.2 and ADR-55/56 wording
alignment does not replace this review with a full-design or implementation
approval. No SDK probes were repeated; the final report was formatted and checked
with Prettier.
