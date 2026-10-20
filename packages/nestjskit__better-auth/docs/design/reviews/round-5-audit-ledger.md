---
audit: ledger
round: 5
audited: design-v6.md
checked: 14
gaps: 5
resolved: 5 fixed, 0 not-a-gap
---

# Round 5 ledger audit: did the accepted fixes land in design-v6.md?

Scope: the 11 round-5 findings with action _accepted_ (NEST-r5-01 to NEST-r5-05, SEC-r5-01 to
SEC-r5-03, BA-r5-01 to BA-r5-03), the two accepted reviewer observations (NEST on contract prose,
SEC on B26), and the one prior finding a round-5 reviewer did not mark resolved (NEST-r1-08,
"still not met, for a new reason"). No finding was rebutted this round, so no rebuttal record was
due. 14 items checked; 5 gaps.

Findings whose every ledger-named element is present, with the reviewer's failure scenario stopped
by the text as written, and with no surviving statement of the old behavior found: **NEST-r5-01**
(except the table noted in G1), **NEST-r5-04**, **NEST-r5-05**, **SEC-r5-01**, **SEC-r5-03**,
**BA-r5-01**, **BA-r5-02**, both observations, and **NEST-r1-08** (met through NEST-r5-01's
collaborator fix plus `LIB-testing-override-everywhere`, §14.8 line 5080).

## Gaps

### G1 — NEST-r5-01

- **status:** partially-applied
- **where:** §2.3 "Tokens and metadata keys (S5)", the `DI tokens` row (line 1311): "`instance:<name>`,
  `options:<name>`, `service:<name>`, `handle:<name>`, `principal-resolver`, `policy-invoker`,
  `policy-resolver` … `mount-coordinator`, `ws-connection-auth`; `ext:<point>:<instance>:<i>`".
- **problem:** §2.3 is the document's canonical list of copy-safe identities, and §1's S5 row (line 310)
  points at it for the new tokens: "v6 adds the `Symbol.for` tokens `GUARD_CORE` and `SCOPE_CORE`, so
  the testing helper's override no longer depends on class identity across copies (§12.5)", with
  traceability "§2.3 (tokens and keys), §12.5". The two tokens are declared in §2.2.8 (lines 922–923)
  and in §5.7's provider table (line 2682) as `Symbol.for(…:guard-core)` / `Symbol.for(…:scope-core)`,
  but §2.3's table never lists them, so the one table that exists to enumerate the dual-load-safe keys
  is incomplete for the mechanism NEST-r5-01 added. No behavior is contradicted; the list is.
- **required change:** add `guard-core` and `scope-core` to §2.3's `DI tokens` row, next to
  `principal-resolver` and `policy-invoker`.

- **Resolution: fixed.** §2.3's `DI tokens` row now lists `guard-core` and `scope-core` between `principal-resolver` and `policy-invoker`, with a one-clause gloss (the guard's and the scope interceptor's bodies; overriding one token reaches every instance) and the tag `[R5:NEST-r5-01]`, pointing at §5.7, §12.5 and §14.8. §1's S5 row now resolves.

### G2 — NEST-r5-02

- **status:** partially-applied
- **where:** §9.2, the bold sub-heading at line 3676: "**Class-level metadata reaches the operations
  only** `[R3:NEST-r3-05]`", followed later in the same paragraph by "**The heading is a shorthand:
  since v5 class-level metadata reaches the class's operations _and_ its federation entry points, and
  only its field resolvers are excluded** `[R5:NEST-r5-02]`".
- **problem:** the ledger note promises "§9.2's heading corrected: class-level metadata reaches
  operations **and** federation entry points, and only field resolvers are excluded", and NEST's
  suggested fix was "Correct §9.2's heading". The heading is the exact sentence NEST quoted as false
  ("§9.2's own heading still says 'Class-level metadata reaches the operations only'"), and it still
  stands verbatim; the correction is a sentence inside the paragraph that a reader scanning headings or
  quoting the section does not reach. Everything else the note names did land: the two printed lists in
  `I_CLASS_METADATA_OPERATIONS_ONLY` (lines 3676, 3690), explicit `inputs: []` for reference resolvers
  (line 3690), `W_ORG_PARAM_MISSING` at `'warn'` (§8.3 line 3526, B21 line 2612), `T-reference-resolver`'s
  third boot (line 4846) and RK38 (line 6167), so the reviewer's 403-everything scenario is reported at
  boot.
- **required change:** reword the heading itself (for example "Class-level metadata reaches the
  operations and the federation entry points, not the field resolvers") and keep the explanatory
  sentence, so no line of §9.2 asserts the v3/v4 rule.

- **Resolution: fixed.** The §9.2 sub-heading now reads "**Class-level metadata reaches the operations and the federation entry points, not the field resolvers** `[R3:NEST-r3-05]` `[R5:NEST-r5-02]`", so no line of §9.2 asserts the v3/v4 rule. The explanatory sentence is kept and re-anchored to the info code's name ("The code's name `I_CLASS_METADATA_OPERATIONS_ONLY` is a shorthand, kept for continuity: …"), since it is that name, not the heading, that still says "operations only".

### G3 — NEST-r5-03

- **status:** inconsistency (stale cross-reference after the promised renumbering)
- **where:** §7.8, "Where the lookup runs", line 3346: "**`BetterAuthService.principalFor(ctx)`**
  compiles or fetches the plan and runs **items 1 to 5** with the transport's `describe()` (or
  `lineage()` for public plans)." The same sentence reads identically in design-v5.md line 3258.
- **problem:** the ledger note promises "§7.8's items renumbered (5 → 6 for `NO_AUTH_RESULT`)". In v5
  item 5 was the throw item, so "items 1 to 5" included `principalFor`'s own
  `PRINCIPAL_READ_BEFORE_GUARD` throw. In v6 the new kind-check is item 5 and the throw item is 6
  (line 3340: "`principalFor` on a plan that is neither public nor inherit throws …
  `PRINCIPAL_READ_BEFORE_GUARD`"), but this sentence was not renumbered: as written, `principalFor`
  now runs a param-decorator-only rule it cannot use and stops short of the item that defines its own
  error. Every other `§7.8 item n` reference in the document was renumbered correctly (lines 300, 2728,
  3191, 3267, 3674, 4666, 4754, 4833, 5079, 5713).
- **required change:** change "items 1 to 5" to "items 1 to 4 and 6" (or "items 1 to 6"; item 5 is a
  no-op for a reader that is not a kind-constrained param decorator).

- **Resolution: fixed.** §7.8 "Where the lookup runs" now reads "runs **items 1 to 4 and 6**", with the reason stated once: "item 5 belongs to kind-constrained param decorators, which `principalFor` is not `[R5:NEST-r5-03]`". No other `§7.8 item n` reference needed changing.

### G4 — SEC-r5-02

- **status:** contradicted
- **where:** four normative places still state v5's `enforce`-keyed trigger:
  - §3.1 U11 (line 1360): "Opens the per-invocation scope (… the caller-session check **for an unsafe
    cookie-carrying browser leg**, `internal: false`) around the handler `[R4:SEC-r4-02]`";
  - §10.2, the plugin sketch's before-hook entry 2 comment (line 3926): "caller-session check: a direct
    call that carries the scope's own session-token cookie, in a scope **whose unsafe browser leg
    carries a cookie**";
  - §2.2 `BetterAuthService.api` doc comment (line 615): "a call that carries the caller's session
    cookie **on an unsafe browser leg** whose origin no guard verified … throws
    PUBLIC_HANDLER_USED_CALLER_SESSION. `[R4:SEC-r4-02]`";
  - ADR-70's heading (line 6039): "A direct `auth.api` call that carries the caller's session cookie,
    in a handler scope **whose unsafe browser leg carries a cookie**, needs a passing origin verdict
    for that leg".
- **problem:** the ledger note says the check is "present for every browser leg whose plan's origin
  check is not `'off'`", and passes on a verdict, on better-auth's skip flags, **or** when the guard
  resolved the principal. §7.5 (line 3219 ff.), the `ScopeView.checkCallerSession` doc comment (lines
  3869–3875) and ADR-70's _Revised in v6_ bullet (line 6050) all carry the new rule, and the tests are
  there (`LIB-public-direct-call` GET / GraphQL-query / shadowed-cookie rows at lines 5011–5013, the
  §14.4 GET row at line 4963). The four places above still describe the v5 predicate that SEC-r5-02
  reported: read on their own, a `@Public() @Get('logout')` proxy is outside the check, which is exactly
  the failure scenario the fix closes. ADR-70's heading additionally omits the third passing condition
  (the guard resolved the principal), which is the condition that keeps guarded safe-method routes free
  of a new denial. (Lines 205, 1350, 1416, 3219 and 5145 use "unsafe" in the same v5 sense but read as
  summaries of the motivating case; correcting them too would remove the ambiguity.)
- **required change:** restate the trigger in all four places as "a browser leg whose plan's origin
  check is not `'off'`, safe methods included", and extend ADR-70's heading to "… needs a passing origin
  verdict for that leg, better-auth's skip flags, or a guard run that resolved the principal".

- **Resolution: fixed**, in all four normative places and in the summaries the entry lists as optional.
  - §3.1 U11: the scope contents now read "the leg's own `browserHeaders`, the invocation's reading as a lazy getter, the caller-session check for every cookie-carrying browser leg whose plan's origin check is not `'off'`, safe methods included", tagged `[R4:SEC-r4-02]` `[R5:SEC-r5-01, SEC-r5-02]` (this also closes xref G06).
  - §10.2 before-hook entry 2's comment: "a scope whose browser leg carries a cookie — any method, whenever the plan's origin check is not `'off'`; the kernel's check throws unless the guard verified the leg's origin **or resolved the principal for this invocation**", tagged `[R5:SEC-r5-02]`.
  - §2.2 `BetterAuthService.api` doc comment: same trigger, and the third passing condition added.
  - ADR-70's heading: "… in a handler scope whose browser leg carries a cookie — any method, whenever the plan's origin check is not `'off'` — needs a passing origin verdict for that leg, better-auth's skip flags, or a guard run that resolved the principal …" (this also closes xref G05), and §16's new "New in v5" cell notes the v6 widening.
  - The summaries: §7.5's bold rule heading (xref G07), §0.1 line 205, §0.2 P8, the `headersFrom` doc comment, §3.1 U1, §3.3's split table, §7.5's multi-instance paragraph, §7.6 "Public means no identity", §7.7's request-time fault row, §13.1's configuration row, migration step 11, the §15.2 `@AllowAnonymous()` row and ADR-34's "the verdicts also serve direct calls" bullet no longer say "unsafe". ADR-57's _Revised in v5_ line and §18's v5.0 entry keep the v5 wording, because they record what v5 did.

### G5 — BA-r5-03

- **status:** dangling-reference
- **where:** §8.3 "Deliberately not shipped" (line 3533): "It is recorded as RK37, in RK1's list of
  better-auth internals the design depends on, and **in the upstream proposal list** (bound
  `cacheAllRoles` with an LRU, or key it to the request)"; RK37 (line 6166): "**upstream proposal, next
  to the `verifyApiKey` and `getSessionFromCtx` items**: bound `cacheAllRoles` with an LRU or key it to
  the request". The list those two point at is §7.7 "Known upstream limitations" (lines 3313–3316),
  whose only two bullets are RK2 (`getSessionFromCtx` / `customSession`) and RK18 (`verifyApiKey`).
- **problem:** the ledger note names the upstream proposal list as one of the places the growth is
  recorded, and both §8.3 and RK37 assert it is already there, beside the two items the list actually
  holds. It is not: §7.7 has no `cacheAllRoles` entry, and no other list-shaped upstream-proposal
  section exists in the document. RK1 (line 6130) and §7.9 (line 3391) did receive their entries, so the
  rest of the fix landed.
- **required change:** add a third bullet to §7.7 "Known upstream limitations" for RK37 — the
  organization plugin's module-level, never-evicted `cacheAllRoles` `Map`, written unconditionally by
  `hasPermission` (LEAD-V59), with the proposal to bound it with an LRU or key it to the request — or
  reword §8.3 and RK37 to stop claiming the item is in that list.

- **Resolution: fixed.** §7.7 "Known upstream limitations" gains a third bullet, `RK37`, next to RK2 and RK18: the module-level, never-evicted `cacheAllRoles` `Map` that `hasPermission` writes unconditionally outside both the `useMemoryCache` and `dynamicAccessControl` branches, reached by `/organization/has-permission` (`has-permission.ts:75`, `permission.ts:33-38`, LEAD-V59), why the design accepts it (bounded by membership, not by attacker input), and the proposal to bound it with an LRU or key it to the request `[R5:BA-r5-03]`. §8.3's and RK37's "in the upstream proposal list" claims now resolve (this also makes the ledger's BA-r5-03 note true as written).
