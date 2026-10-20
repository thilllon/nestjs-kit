---
audit: xref
round: 5
audited: design-v6.md
checked: 2158
gaps: 11
resolved: 11 fixed, 0 not-a-gap
---

# Round 5 cross-reference and consistency audit of `design-v6.md`

Mechanical and editorial only: no design judgement. Extraction scripts live in
`/tmp/nsba/tmp-r5-audit-XREF/` (`extract.mjs`, `analyze.mjs`, `cases.mjs`, `cases2.mjs`, `inv.mjs`,
`exports.mjs`, `codes.mjs`, `q.mjs`) and were run over all 6 374 lines of the document.

## Coverage (what the `checked` count covers)

| Series                                                       | Defined                                                       | References              | Result                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Section numbers (`##`–`#####` headings)                      | 162                                                           | 1 308 `§n.m` references | no dangling `§` reference, no duplicate heading number, no gap in any subsection series. Every apparent miss (`§1.1`, `§2.5`, `§3.19`, …) is a `R:<report> §n` research citation, not a self-reference                                                                                                                                                                                                                       |
| `ADR-nn`                                                     | 70 (`ADR-01`–`ADR-70`, one `**ADR-nn.` heading each)          | 609                     | no duplicate, no gap, no dangling; draft ids (`A-ADR-n`, `B-ADR-n`, `C-ADR-n`) correctly namespaced per §16's opening note                                                                                                                                                                                                                                                                                                   |
| Boot checks `Bnn`                                            | 31 (`B01`–`B31`, §5.4)                                        | 481                     | no duplicate, no gap, no dangling                                                                                                                                                                                                                                                                                                                                                                                            |
| Risks `RKnn`                                                 | 39 (`RK1`–`RK39`, §17.2)                                      | 157                     | no duplicate, no gap, no dangling                                                                                                                                                                                                                                                                                                                                                                                            |
| Questions `Qnn`                                              | 38 (`Q1`–`Q38`, §17.1.1–§17.1.3)                              | 265                     | no duplicate, no gap, no dangling                                                                                                                                                                                                                                                                                                                                                                                            |
| `LEAD-Vn`                                                    | 59 (`LEAD-V1`–`LEAD-V59`)                                     | 400                     | no duplicate, no gap, no dangling                                                                                                                                                                                                                                                                                                                                                                                            |
| `LEAD-EXP-n`                                                 | 13 (`LEAD-EXP-1`–`LEAD-EXP-13`)                               | 126                     | no duplicate, no gap, no dangling                                                                                                                                                                                                                                                                                                                                                                                            |
| Invariants / units                                           | `H1`–`H14`, `T1`–`T10`, `P1`–`P7`, `Z1`–`Z6`, `U1`–`U19` (56) | —                       | no duplicate, no gap. `P8`/`P10`/`P11` resolve to §0.2's better-auth principles, which §4.3.2's closing note explicitly disambiguates                                                                                                                                                                                                                                                                                        |
| Conformance / test case ids (`H-`, `T-`, `S-`, `Z-`, `LIB-`) | 147 distinct, each present in §14                             | —                       | one changelog-only historical id, `H-unbind-on-close`, correctly marked in the v5 entry as replaced by `H-close-keeps-hooks`                                                                                                                                                                                                                                                                                                 |
| Finding ids `<BA\|NEST\|SEC>-r<n>-<nn>`                      | 126 distinct                                                  | 1 734 occurrences       | all 11 round-5 ids present (`BA-r5-01..03`, `NEST-r5-01..05`, `SEC-r5-01..03`); none invented. All 22 `[R5:…]` tag spellings are legal forms of the "How to read" grammar                                                                                                                                                                                                                                                    |
| Error / warning codes (SCREAMING_SNAKE in backticks)         | 157 distinct, 24 `W_*`, 1 `I_*`                               | —                       | every `W_*`/`I_*` code the library emits is listed by the boot check that emits it. The two single-occurrence library-looking codes (`W_NO_STALE_CONTEXT_CHECK`, `FEDERATION_ENTITY_UNGUARDED`) appear only as _rejected alternatives_ in §16, which is correct                                                                                                                                                              |
| §2.2 exported symbols                                        | 181 `export` declarations + 25 type re-exports                | —                       | no duplicate declaration; each of the 25 re-exported type names has exactly one definition in §11.3; every name §15.2's migration table maps to exists in §2.2. The 17 decorator-shaped names used but not exported are all reference-library names (`@AllowAnonymous`, `@Roles`, `@Hook`, …), rejected alternatives (`@NoAuthCookies`, `@InheritAuth`, `@RequireSameOrigin`, `@AuthHooks`) or third-party (`@SkipThrottle`) |
| Numbered step lists                                          | §5.7 (4), §7.6 (9), §7.8 (6), §12.9 (10), §15.1 (16)          | 52 `step n` references  | every `step n` reference is in range for the list it names                                                                                                                                                                                                                                                                                                                                                                   |
| `REV5-*` experiment citations                                | 6                                                             | —                       | each appears in the matching `reviews/round-5-*.md`                                                                                                                                                                                                                                                                                                                                                                          |
| `node tools/sync-parts.mjs design-v6.md v6-parts --check`    | —                                                             | —                       | **`28 parts, 0 differ; the parts reproduce design-v6.md`**                                                                                                                                                                                                                                                                                                                                                                   |

**Placeholders.** No `TODO`, `TBD`, `FIXME`, `XXX`, `???`, `<placeholder>`, "to be decided" or "to be
determined" anywhere. The two "placeholder" hits (lines 244, 5094) are prose about the _user's_ empty
better-auth `hooks: {}` object. All four "see above"/"see below" references (lines 3505, 3548, 3652, 5746)
have a target in the same subsection.

**§17 completeness.** All 38 question rows carry options, a recommendation and an explicit decided status
(`Q1`–`Q12` and `Q35`–`Q38` via "Decided by the owner's standing decision of 2026-09-17", `Q13`–`Q34` via
"Decided by the owner on 2026-09-17"). No row is missing a column.

**ADR provenance.** All 8 ADRs carrying a `*Revised in v6*` line (ADR-41, 51, 61, 64, 66, 67, 69, 70) cite
round-5 finding ids in that line. The §18 v6.0 changelog entry exists.

---

## Gaps

### G01 — §16's preamble still describes the document as v5 and never mentions round 5

- **status:** placeholder (leftover v5 wording where v6 is meant)
- **where:** §16, line 5211: "**ADR-01 to ADR-33** are the v1 decisions. Each states the decision **as it
  stands in v5**. … Where review round 2, 3 or 4 changed one, a _Revised in v3_, _Revised in v4_ or _Revised
  in v5_ line does the same."
- **problem:** the document is v6 and contains eight `*Revised in v6*` lines, none of which the preamble
  accounts for. A reader following the preamble concludes that ADR text states the v5 position and that no
  round-5 revision exists. The four following bullets stop at v5 in the same way, and each is contradicted by
  the ADRs it describes:
  - line 5212, "ADR-34 to ADR-53 … _Revised in v3_ to _Revised in v5_ lines record later changes" — ADR-41 and
    ADR-51 are both revised in v6;
  - line 5213, "ADR-54 to ADR-63 … _Revised in v4_ and _Revised in v5_ lines record later changes" — ADR-61 is
    revised in v6;
  - line 5214, "ADR-64 to ADR-68 … where round 4 changed one (all but ADR-65), a _Revised in v5_ line records
    the change" — ADR-64, ADR-66 and ADR-67 are revised in v6;
  - line 5215, "**ADR-69 and ADR-70** are decisions v5 introduced. Each cites the round-4 findings that forced
    it." — both are revised in v6.
- **required change:** change "as it stands in v5" to "as it stands in v6", and extend all four bullets to name
  round 5 / _Revised in v6_, exactly as every earlier round is named.

- **Resolution: fixed.** §16's preamble now says the ADR text states the decision "**as it stands in v6**", and each of the four bullets names round 5: ADR-01–33 gain "_Revised in v3_, _Revised in v4_, _Revised in v5_ or _Revised in v6_"; ADR-34–53 read "_Revised in v3_ to _Revised in v6_ lines record later changes (round 5 changed ADR-41 and ADR-51)"; ADR-54–63 read "_Revised in v4_ to _Revised in v6_ … (round 5 changed ADR-61)"; ADR-64–68 name ADR-64, ADR-66 and ADR-67; and ADR-69/ADR-70 "both carry a _Revised in v6_ line for the round-5 findings that widened them".

### G02 — §16 has no "Changed in v6 | New in v6" table

- **status:** missing
- **where:** §16, lines 5217–5230. The tables run "Changed in v5 | New in v5", "Changed in v4 | New in v4",
  "Changed in v3 | New in v3", "Changed in v2 | New in v2". There is no v6 row.
- **problem:** §16 gives one such table per revision as the index of what that round moved; v5 is currently the
  newest indexed revision. That v6 revised eight ADRs and added none is recorded only inside the §18 changelog
  paragraph, so §16 read on its own is stale.
- **required change:** add, above the "Changed in v5" table and in the same format:

  | Changed in v6                      | New in v6                                                 |
  | ---------------------------------- | --------------------------------------------------------- |
  | ADR-41, 51, 61, 64, 66, 67, 69, 70 | _(none; round 5 moved no decision that needed a new ADR)_ |

- **Resolution: fixed.** A "Changed in v6 | New in v6" table now stands above the v5 one, in the same format, with `ADR-41, 51, 61, 64, 66, 67, 69, 70` and _(none; round 5 moved no decision that needed a new ADR)_. The v5 table's ADR-70 cell notes the v6 widening in ADR-70's new wording, so the two index entries agree (see G05).

### G03 — the v6.0 changelog entry has no "Decision log and risks" and no "Verification" bullet

- **status:** missing (inconsistent with every earlier version entry)
- **where:** §18, lines 6174–6194. The v6.0 sub-bullets are: _No open questions_, _Two mechanisms replaced
  rather than patched_, _Security_, _NestJS correctness_, _better-auth fidelity_, _Contracts_, _Boot checks_,
  _Conformance and tests_.
- **problem:** every earlier entry ends with a **Decision log and risks** bullet and a **Verification** bullet
  (v5.0 lines 6222–6223; v4.0 line 6084; v3.0 line 6114; v2.0 line 6151). v6 introduced `LEAD-V57`, `LEAD-V58`,
  `LEAD-V59` and `LEAD-EXP-13` — four new verification records, three of them better-auth source re-checks —
  and **none of the four is named anywhere in §18**. `RK37`–`RK39`, the revised `RK32` and the eight revised
  ADRs are named only in passing in the entry's opening paragraph, not in the structured bullet the other
  entries use, so the per-version index of decisions, risks and evidence breaks at v6.
- **required change:** add to the v6.0 entry, in v5.0's form:
  - **Decision log and risks.** No ADR added; ADR-41, 51, 61, 64, 66, 67, 69 and 70 revised. Q38 added and
    decided. RK37 to RK39 added; RK32 extended.
  - **Verification.** LEAD-V57 to LEAD-V59 (the JWT plugin's `iss`/`aud` baseURL **origin**; better-auth's
    module-load `NODE_ENV` snapshot; the organization plugin's unconditional `cacheAllRoles` write) and
    LEAD-EXP-13 (`tmp-r5-revise/guardcore.ts`, `@nestjs/core` 11.2.5 and 12.0.3, identical output: the
    `overloadsMap`-per-token override table).

- **Resolution: fixed.** The v6.0 entry now ends, in v5.0's form and order (after _Conformance and tests_), with **Decision log and risks** (no ADR added; ADR-41, 51, 61, 64, 66, 67, 69 and 70 revised, indexed by §16's new table; Q38 added and decided, Q9's rationale corrected; RK37 to RK39 added, RK1 and RK32 extended) and **Verification** (LEAD-V57 to LEAD-V59, each identical on 1.7.0 and 1.7.4, and LEAD-EXP-13 on `@nestjs/core` 11.2.5 and 12.0.3, plus the reviewers' REV5 experiments).

### G04 — §2.3's token table does not list `guard-core` / `scope-core`, although §1 points at §2.3 for them

- **status:** partially-applied
- **where:** §2.3, line 1310, "DI tokens" row: `instance:<name>`, `options:<name>`, `service:<name>`,
  `handle:<name>`, `principal-resolver`, `policy-invoker`, `policy-resolver` (U19), `transports`,
  `transport-registry`, `platforms`, `principal-sources:<name>`, `instance-registry`, `request-scope`,
  `mount-coordinator`, `ws-connection-auth`; `ext:<point>:<instance>:<i>`.
- **problem:** v6 added two `Symbol.for` DI tokens. §2.2.8 declares them with their keys (lines 922–923,
  `// Symbol.for('nestjs-slightly-better-auth:guard-core')` and `…:scope-core`), §5.7 repeats both keys
  (line 2682), and §1's S5 traceability row (line 310) reads "v6 adds the `Symbol.for` tokens `GUARD_CORE` and
  `SCOPE_CORE`" while citing **§2.3 (tokens and keys)** as the place they are recorded. §2.3 — the document's
  single canonical list of copy-safe identities, whose stated purpose is that "Every identity-sensitive value
  is copy-safe" — was not updated, so the row §1 points at does not contain them.
- **required change:** add `guard-core` and `scope-core` to §2.3's "DI tokens" row, next to `principal-resolver`
  and `policy-invoker`.

- **Resolution: fixed.** §2.3's `DI tokens` row now lists `guard-core` and `scope-core` next to `principal-resolver` and `policy-invoker`, glossed as the guard's and the scope interceptor's bodies and tagged `[R5:NEST-r5-01]`. (Same gap as the ledger audit's G1.)

### G05 — ADR-70's title still restricts the caller-session check to an _unsafe_ browser leg, which its own v6 revision widened

- **status:** contradicted
- **where:** §16, line 6039: "**ADR-70. A direct `auth.api` call that carries the caller's session cookie, in a
  handler scope whose **unsafe** browser leg carries a cookie, needs a passing origin verdict for that leg:
  otherwise it fails with `PUBLIC_HANDLER_USED_CALLER_SESSION`.**"
- **problem:** the ADR's own _Revised in v6_ line (line 6050, `[R5:SEC-r5-02]`) states the opposite: "The check
  is now present for **every** browser leg whose plan's origin check is not `'off'`, passes when the guard
  resolved the principal for the invocation (so guarded routes, **safe methods included**, gain no denial)".
  The contract agrees with the revision, not the title: `ScopeView.checkCallerSession` (line 3868) reads
  "Present in EVERY handler scope whose transport exposes a browser leg, unless the plan's origin check is
  `'off'` — enforcing or not, so safe methods and GraphQL queries are covered too". A decision's headline is
  what §16's index tables and §7.5 quote, so the shipped rule is stated wrongly in the one line that is quoted
  most.
- **required change:** retitle ADR-70 without "unsafe", e.g. "… in a handler scope whose browser leg carries a
  cookie, needs a passing origin verdict for that leg or a guard run for the invocation: otherwise it fails
  with `PUBLIC_HANDLER_USED_CALLER_SESSION`." Use the same wording in any v6 index table added per G02.

- **Resolution: fixed.** ADR-70's title now reads "A direct `auth.api` call that carries the caller's session cookie, in a handler scope whose browser leg carries a cookie — any method, whenever the plan's origin check is not `'off'` — needs a passing origin verdict for that leg, better-auth's skip flags, or a guard run that resolved the principal: otherwise it fails with `PUBLIC_HANDLER_USED_CALLER_SESSION`." The v5 index table's ADR-70 cell carries the same widening in short form.

### G06 — §3.1 unit U11 still describes the caller-session check with v5's `enforce`-keyed trigger

- **status:** contradicted
- **where:** §3.1, line 1360: "| U11 | `ScopeCore` (behind `SCOPE_CORE`; …) `[R5:NEST-r5-01]` | Opens the
  per-invocation scope (cookie sink, forwarding mode, inbound credential view, the invocation's reading, **the
  caller-session check for an unsafe cookie-carrying browser leg**, `internal: false`) around the handler
  `[R4:SEC-r4-02]` |"
- **problem:** the description of the scope's contents is **byte-identical to v5's U11** (verified by diffing
  `design-v5.md`); only the unit's name changed. It therefore still says "unsafe", still carries only
  `[R4:SEC-r4-02]`, and omits `browserHeaders`, which v6 added to `ScopeView` (line 3878, `[R5:SEC-r5-02]`)
  specifically so this check can see an ambiently carried cookie. §18's Contracts bullet (line 6192) claims
  "units U10 and U11 (§3.1) name the collaborators" — U10 _was_ also updated for behavior and carries
  `[R5:NEST-r5-05]`; U11 was not.
- **required change:** reword U11's scope contents to "the caller-session check for every cookie-carrying
  browser leg whose plan's origin check is not `'off'`", add `browserHeaders` to the listed contents, and tag
  the row `[R4:SEC-r4-02]` `[R5:SEC-r5-01, SEC-r5-02]`.

- **Resolution: fixed.** U11's scope contents now read "cookie sink, forwarding mode, inbound credential view, **the leg's own `browserHeaders`**, the invocation's reading **as a lazy getter**, the caller-session check **for every cookie-carrying browser leg whose plan's origin check is not `'off'`, safe methods included**, `internal: false`", tagged `[R4:SEC-r4-02]` `[R5:SEC-r5-01, SEC-r5-02]`, so §18's Contracts claim about U10 and U11 holds.

### G07 — §7.5's bold heading for the rule keeps the same stale "unsafe leg" wording

- **status:** contradicted
- **where:** §7.5, line 3219: "**No direct call acts with the caller's session on an unverified unsafe leg**
  `[R4:SEC-r4-02]`."
- **problem:** ten lines below, the same subsection reads "Two cases this closes that v5's `enforce`-keyed
  trigger left open: **Safe methods.** v5 keyed presence on `browser.enforce`, which is false for GET, HEAD and
  OPTIONS …" (line 3229). The heading of the rule and the rule contradict each other, and the heading carries
  only the round-4 tag while the body carries the round-5 correction.
- **required change:** drop "unsafe" from the heading ("No direct call acts with the caller's session on an
  unverified leg") and tag it `[R4:SEC-r4-02]` `[R5:SEC-r5-01, SEC-r5-02]`.

- **Resolution: fixed.** The §7.5 heading now reads "**No direct call acts with the caller's session on an unverified leg** `[R4:SEC-r4-02]` `[R5:SEC-r5-01, SEC-r5-02]`". Eleven further summary sentences that carried the same "unsafe leg" wording were corrected with it (listed under the ledger audit's G4); only ADR-57's _Revised in v5_ line and §18's v5.0 entry keep it, because they record what v5 did.

### G08 — §4.2.4's tRPC sketch computes `enforce` in a way §4.2.1's contract forbids

- **status:** contradicted
- **where:** §4.2.4, line 2032:
  `browser: { enforce: request.method !== 'GET', headers: () => http.headers(req), url: request.url, key: http.key(req) },`
- **problem:** `BrowserExposure.enforce` is normatively defined in §4.2.1 (lines 1891–1897) as "The operation is
  unsafe for the origin check: **HTTP methods other than GET/HEAD/OPTIONS**, GraphQL mutations over HTTP, and
  EVERY operation carried by a WebSocket". The document's own built-in HTTP transport implements exactly that
  (§9.1, line 3623: `enforce: !['GET', 'HEAD', 'OPTIONS'].includes(request.method)`), §7.10 item 2 repeats it,
  and LEAD-V16 records that better-auth's own rule skips GET/HEAD/OPTIONS. The third-party sketch — the worked
  example a third party copies, and the only `enforce` implementation in §4 — would enforce the origin check on
  HEAD and OPTIONS, which invariant T8 (`T-csrf-safe-methods`) requires not to happen.
- **required change:** change the sketch to
  `enforce: !['GET', 'HEAD', 'OPTIONS'].includes(request.method)`, matching §4.2.1, §7.10 and §9.1.

- **Resolution: fixed.** The §4.2.4 tRPC sketch now computes `enforce: !['GET', 'HEAD', 'OPTIONS'].includes(request.method)`, with the inline comment "§4.2.1: safe methods are not enforced (T8)", matching §4.2.1, §7.10 item 2 and §9.1.

### G09 — §18's v6 changelog says B16 changed, but B16 is byte-identical to v5, and `globalScope: false` now trips it

- **status:** contradicted / partially-applied
- **where:** §18, line 6193: "**Boot checks.** B31 (`W_NO_GLOBAL_SCOPE`) is new. **B16 (the scope interceptor
  is global whatever `globalGuard` says)**, B21 (three new advice codes), B22 (…) and B30 (…) changed."
- **problem:** two mechanical defects.
  1. Diffing `design-v5.md` against `design-v6.md` row by row: B21, B22, B26 and B30 differ, **B16 is
     identical**. B16's row also carries no inline `R5:` finding id and no `[R5]` provenance tag (its tag
     column is `[C] [R1] [R2] [R3] [R4]`), while every other check the same sentence names does carry one. So
     the changelog lists a change that is not in the document.
  2. The unchanged B16 rule reads "a claimed handler is covered when … its reach is `'global'` and the
     application's global enhancers include **both** `BetterAuthGuard` and `BetterAuthScopeInterceptor`,
     whoever registered them; or `@UseBetterAuth()` … applies". Under v6's new `globalScope: false` with
     `globalGuard: true`, the global list holds the guard but not the interceptor, so **every** claimed handler
     that declares something and lacks `@UseBetterAuth()` fails boot with `ROUTE_UNGUARDED` (an _error_). That
     contradicts B31, which is a _warn_ for exactly that configuration and whose hint asks only for
     "`@UseBetterAuth()` **to every handler that calls `auth.api`**", and §5.7 line 2728, which presents the
     opt-out as "An app that genuinely wants zero library enhancers sets `globalScope: false` and gets
     `W_NO_GLOBAL_SCOPE` (B31) and a boot-summary line."
- **required change:** either state in B16 how it treats the two enhancers now that they are registered
  independently (and tag the row `[R5:SEC-r5-01]`), or correct §18's sentence to drop B16 from the list of
  checks that changed. Whichever is chosen, reconcile B31's hint and §5.7's "warning only" framing with B16's
  error, so one severity is stated for `globalScope: false`.

- **Resolution: fixed**, by making B16 true rather than by dropping it from §18. B16's coverage condition now reads "its reach is `'global'` and the application's global **guards** include `BetterAuthGuard` … or `@UseBetterAuth()` (or `@UseGuards(BetterAuthGuard)`) applies", followed by "**Coverage keys on the guard alone since v6** `[R5:SEC-r5-01]`", which states why (the two enhancers were a pair until v5 and are registered independently now) and what the old wording would have done (`ROUTE_UNGUARDED` for every claimed handler under `globalScope: false` with `globalGuard: true`). The row's inline tag `[R5:SEC-r5-01]` and its provenance column `[C] [R1] [R2] [R3] [R4] [R5]` were added. Severity is now stated once: B16's text, B31's row, B31's `W_NO_GLOBAL_SCOPE` message and §5.7's opt-out paragraph all say `globalScope: false` produces a warning and never a per-handler error; B31 additionally lists the claimed handlers without `@UseBetterAuth()`, forwarding ones first, and its message names the lost cookie forwarding. §18's sentence now describes the real B16 change and adds B26, which the audit's own diff found changed.

### G10 — B22's provenance tag column omits `[R5]` although the row carries two round-5 finding ids inline

- **status:** inconsistency
- **where:** §5.4, line 2613. The row text contains "Since v6 it prints the scope interceptor's state …
  `[R5:SEC-r5-01]`" and "with **three** reason templates … `[R4:BA-r4-02]` `[R5:BA-r5-02]`", but its
  provenance column is `[A][B][C] [R1] [R2] [R3] [R4]`.
- **problem:** "How to read this document" defines the bare `[R1]`–`[R5]` marker as the tag for "a table row or
  paragraph whose finding ids are given inline". B22 is the **only** row in the §5.4 table where an inline
  `R5:` id is not matched by an `[R5]` in the tag column (B21, B26, B30 and B31 all match). The v6 changelog
  also names B22 among the checks that changed, so the row is provably a round-5 change with no round-5 tag.
- **required change:** change B22's tag column to `[A][B][C] [R1] [R2] [R3] [R4] [R5]`.

- **Resolution: fixed.** B22's provenance column is now `[A][B][C] [R1] [R2] [R3] [R4] [R5]`.

### G11 — §1's D4 traceability note stops at v5 although v6 added better-auth floor re-checks

- **status:** partially-applied
- **where:** §1, line 305: "| D4 | better-auth `>=1.7.0 <2` | … | v2's new better-auth dependencies were
  checked at the floor (LEAD-V33); v3's, v4's and v5's experiments ran on 1.7.0 and 1.7.4 (LEAD-EXP-8 to 12) |"
- **problem:** v6 added three better-auth source re-checks, two of which state the floor result explicitly —
  LEAD-V57 ("REV5-BA:`exp1-jwt-issuer.mjs` (identical on 1.7.0 and 1.7.4)") and LEAD-V58
  ("REV5-BA:`exp4-env-snapshot.mjs` (identical on 1.7.0 and 1.7.4)") — plus LEAD-V59, a **new** dependency on
  an undocumented better-auth behavior (the organization plugin's unconditional `cacheAllRoles` write) that
  RK37 and RK1 now rest on. The D4 row is the one place tracing the floor claim to evidence and it names
  nothing from round 5. The adjacent R4 row (line 300) _was_ extended for v6, so the omission is inconsistent
  inside the same table.
- **required change:** extend the D4 note, e.g. "… v6's re-checks ran on 1.7.0 and 1.7.4 too (LEAD-V57,
  LEAD-V58); LEAD-V59 adds the organization plugin's unconditional `cacheAllRoles` write to the undocumented
  surfaces RK1 tracks."

- **Resolution: fixed.** §1's D4 note now continues "; v6's re-checks ran on both too (LEAD-V57, the JWT `iss`/`aud` origin; LEAD-V58, the import-time `NODE_ENV` snapshot), and LEAD-V59 adds the organization plugin's unconditional `cacheAllRoles` write to the undocumented better-auth surfaces RK1 tracks `[R5:BA-r5-01, BA-r5-02, BA-r5-03]`".

---

## Checks that passed and are worth recording

- `node tools/sync-parts.mjs design-v6.md v6-parts --check` → `28 parts, 0 differ`.
- Every numbered series (`ADR`, `B`, `RK`, `Q`, `LEAD-V`, `LEAD-EXP`, `H`, `T`, `P`, `Z`, `U`) is contiguous
  with no duplicate definition and no reference outside its defined range.
- All 147 conformance/test case ids are defined in §14; every id referenced from §4–§13 and §16 resolves there.
- All 11 round-5 findings are cited; the eight `*Revised in v6*` ADR lines each cite finding ids; every `[R5:…]`
  tag spelling matches the grammar declared in "How to read this document".
- The v6-specific changes checked end to end and found consistently applied across every section that mentions
  them: `isLive` required (§2.2, §4.1.1 line 1642, §4.1.4 Hono sketch lines 1729/1741/1773, T8, §9.2, §16,
  §18); `globalScope` (§2.2.1, §5.2, §5.4 B22/B31, §5.7, §15.2, §17 Q38, §18); the read-time kind constraint
  (§7.6 item 6, §7.8 item 5, ADR-41, `W_NESTED_PRINCIPAL_PARAM` in B21); the JWT `iss`/`aud` origin (§4.3.4
  lines 2296–2314, LEAD-V57, `S-jwt-claims`, §18); `cacheAllRoles` (§0.4 line 286, §7.9 line 3391, §8.3 line
  3533, Q9, RK37, LEAD-V59); the federation/field-guard cost (`W_FIELD_GUARDS_MULTIPLY_GLOBAL_ENHANCERS` in
  B21, §9.2, RK39, ADR-69); `NODE_ENV` as an import-time snapshot (B22, B30, ADR-67, LEAD-V58).

---

## Re-run after the fixes (lead architect, 2026-09-17)

All 11 xref gaps and all 5 ledger-audit gaps are fixed; none was answered "not a gap". The audit's own
extraction scripts (`/tmp/nsba/tmp-r5-audit-XREF/`: `extract.mjs`, `analyze.mjs`, `cases.mjs`, `cases2.mjs`,
`inv.mjs`, `exports.mjs`, `codes.mjs`, `q.mjs`) were re-run over the revised document and report the same
clean series as above: `ADR` 1–70, `B` 1–31, `RK` 1–39, `Q` 1–38, `LEAD-V` 1–59, `LEAD-EXP` 1–13, no
duplicate, no gap, no dangling `§`, no new undefined reference (the `§1.1`/`§2.5`/`§3.19` hits remain the
`R:<report> §n` research citations). `node tools/sync-parts.mjs design-v6.md v6-parts --check` →
`28 parts, 0 differ; the parts reproduce design-v6.md`.
