// Render role prompts for a maintainer-run design review; do not execute them.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    round: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string" },
    scratch: { type: "string", default: "/tmp/nsba" },
    "continue-partial": { type: "boolean", default: false },
  },
});

function requiredOption(name: "round" | "from" | "to" | "out"): string {
  const value = values[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

function positiveInteger(name: "round" | "from" | "to"): number {
  const value = requiredOption(name);
  if (
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > 1000
  ) {
    throw new Error(`--${name} must be an integer between 1 and 1000`);
  }
  return Number(value);
}

const ROUND = positiveInteger("round");
const FROM = positiveInteger("from");
const TO = positiveInteger("to");
if (TO !== FROM + 1) {
  throw new Error("--to must be the revision immediately after --from");
}
const CUR = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = resolve(CUR, "../..");
const D = fileURLToPath(new URL("../", import.meta.url));
const scratch = values.scratch;
if (scratch.trim() === "") {
  throw new Error("--scratch must not be empty");
}
const SP = resolve(CUR, scratch);
const BA = join(SP, "better-auth");
const REF = join(SP, "ref");
const PRIOR_ROUNDS = Array.from({ length: ROUND - 1 }, (_, index) => index + 1);
if (!existsSync(join(D, `design-v${FROM}.md`))) {
  throw new Error(`Source design-v${FROM}.md does not exist`);
}
if (values["continue-partial"] && !existsSync(join(D, `design-v${TO}.md`))) {
  throw new Error("--continue-partial requires an existing target design");
}

const CONTEXT = `PROJECT
We are DESIGNING (not implementing) \`nestjs-slightly-better-auth\`: a from-scratch NestJS integration for better-auth. We learned from @thallesp/nestjs-better-auth v2.8.0, but this is a clean break.

HARD REQUIREMENTS (from the user, non-negotiable)
R1 Honor better-auth's own philosophy and integration model (framework-agnostic Web handler, plugin-first extension, inference-driven types, secure by default). Do not reimplement what better-auth already does.
R2 HTTP platforms are pluggable through an adapter contract. Express and Fastify ship first-class; any other server / middleware stack can be attached by a third party without editing our code.
R3 Ships dual CJS + ESM.
R4 SOLID, especially Open-Closed: new HTTP platforms, transports, principal sources, authorization policies and hooks are added by extension, never by editing core. Core must not switch/if on platform names, transport names or policy kinds.
R5 Toolchain: pnpm, tsdown (0.23.x), vitest, biome.

USER DECISIONS (already made; do not reopen)
D1 Peer ranges: @nestjs/* ^11 || ^12; Node engines >=22.12; dual CJS+ESM (the CJS build relies on require(esm) because better-auth and Nest 12 are ESM-only).
D2 v1 ships built-in support for: HTTP on Express and Fastify; GraphQL via Apollo AND Mercurius; WebSocket gateways (socket.io and ws); Microservices/RPC. Each must still be an extension unit, not core code.
D3 Clean break from @thallesp's API: choose the best names/semantics; include a migration guide section.
D4 better-auth peer range: >=1.7.0 <2.

STRONG DEFAULTS FROM RESEARCH (deviate only with explicit, evidence-backed justification written into the doc)
S1 Never mutate auth.options after betterAuth(); bridge Nest-side hooks through a better-auth plugin, preserving hook return-value semantics.
S2 On cookie-capable transports, server-side getSession uses returnHeaders:true and forwards ONLY set-cookie; on transports that cannot write cookies, refresh is deliberately suppressed.
S3 The auth mount path comes from better-auth itself, all HTTP methods, outside Nest's global prefix unless deliberately designed otherwise.
S4 Auth routes receive the untouched request body stream; app routes keep Nest-native parsing incl. rawBody; a body size limit is enforced on auth routes.
S5 Copy-safe identities (Symbol.for / namespaced tokens and metadata keys), explicit @Inject, an explicit dual-package-hazard strategy.
S6 Detect better-auth errors with isAPIError, never instanceof. Infrastructure failures surface as 5xx, never as 401/403.
S7 Resolve the principal lazily, at most once per request.

PRODUCT QUESTIONS: THE OWNER'S STANDING DECISION
The owner has decided (2026-09-17) that every product question in §17, including any question a later round adds, is decided as its recommended option. Treat decided questions like D1-D4. Raise a finding about one only when the decided answer causes a concrete defect (a failure scenario with evidence); the fix must then keep the decision or propose a new question with a recommendation, which is decided the same way.

CURRENT MONOREPO POLICY
Read ${ROOT}/AGENTS.md first. This package lives inside nestjs-kit. Historical designs describe the standalone project and do not override current repository rules: protected pull requests, package-specific options-token helpers, direct Nest @Inject() instead of injection wrappers, shared toolchain, and English documentation. Keep historic findings intact; record any design adjustment needed to follow current maintainer decisions. No prompt authorizes a commit, push, publication, or autonomous scheduled run.

RESOURCES
- Design workspace: ${D}
  - ${D}/design-v${FROM}.md: the design under review. Earlier versions design-v1.md .. design-v${FROM - 1}.md were rejected (read-only).
  - ${D}/ledger.md: every earlier finding with its action and a note on the fix and the ADR that records it, round by round.
  - ${D}/reviews/round-<n>-{BA,NEST,SEC}.md: the findings of rounds ${PRIOR_ROUNDS.join(", ")} in full.
  - ${D}/research/_digest.md and nine full research reports next to it.
  - ${D}/tools/splice.mts and ${D}/tools/sync-parts.mts (\`pnpm exec tsx "${D}/tools/sync-parts.mts" <doc> <partsDir> [--check]\`).
- better-auth 1.7.4 source (read-only): ${BA}. @thallesp/nestjs-better-auth v2.8.0 source (read-only): ${REF}.
- Experiments and downloads: ONLY in your own directory ${SP}/tmp-r${ROUND}-<your-label>/. Older text mentions tmp-* experiment directories that no longer exist; treat their results as recorded findings and re-run an experiment before relying on it for a NEW conclusion. Install what you need there (for example @nestjs/* 11.1.17 and 12.0.1, fastify, express, mercurius, @apollo/server, socket.io, ws, better-auth 1.7.4 and 1.7.0).

BOUNDARIES
- Write documents only inside ${D}, and only where your role says. Never run a git command that changes state (no add, commit, push, checkout, stash, reset); the orchestrating session commits. Ignore changes elsewhere in ${CUR}.
- CHECKPOINTING: sessions can end without warning. Save to disk after every subsection you finish.`;

const REVIEWERS = [
  {
    key: "BA",
    name: "better-auth core maintainer",
    lens: "Fidelity to better-auth's philosophy and exact runtime semantics. Check every claim the design makes about better-auth (handler pipeline, basePath/baseURL, body reading, origin/CSRF, rate limit and IP, getSession Set-Cookie paths, cookie cache, hooks and plugin contract incl. ordering and return values, databaseHooks, APIError, $context, $Infer, customSession, admin/organization/api-key/jwt/bearer/oauth-provider plugins) against the 1.7.x source, at BOTH the 1.7.0 floor and 1.7.4. Hunt for reimplementation of better-auth behavior, misuse of its extension points, broken plugin compatibility, type-inference loss, and anything likely to break across 1.7 -> 1.x minor upgrades.",
  },
  {
    key: "NEST",
    name: "NestJS core maintainer and SOLID/OCP auditor",
    lens: "NestJS correctness on BOTH Nest 11 and 12 (module lifecycle timing, NestFactory vs @nestjs/testing, DI tokens and scopes, guards/Reflector/decorators, ExecutionContext per transport, Apollo vs Mercurius, socket.io vs ws, microservices incl. hybrid apps, exception filters per transport) and packaging (dual CJS/ESM hazard, decorator metadata under tsdown, subpath exports, optional peers). Audit SOLID rigorously: any place core must be edited to add a platform/transport/policy/principal source (OCP), fat interfaces (ISP), adapters that need special cases to substitute (LSP), core depending on concretions (DIP), units with more than one reason to change (SRP). The design has grown with every round; check whether the mechanisms added in response to earlier findings kept core small and the contracts coherent, and say so when a mechanism should be removed rather than patched. Also testability for consumers.",
  },
  {
    key: "SEC",
    name: "security engineer and production SRE",
    lens: "Security: CSRF/origin checks (including the ways a request can be exempted from them), CORS, body-parsing bypasses and size limits, raw-body integrity, trust of forwarded headers and rate-limit bucket collapse, cookie forwarding and refresh drift, session fixation, information leakage in errors/logs/serialized sessions, stale authorization via cookie cache, api-key quota, privilege escalation via principal kinds and delegation, WS/RPC credential carriage. Operations: behavior when the DB or secondary storage is down, startup validation, diagnostics for misconfiguration, per-request cost, memory growth, graceful shutdown, test isolation, upgrade and migration safety.",
  },
];

const REVIEW_FRONT_MATTER = (key: string) => `---
reviewer: ${key}
round: ${ROUND}
reviewed: design-v${FROM}.md
verdict: approve | reject
blockers: <count of new blocker findings>
majors: <count of new major findings>
minors: <count of new minor findings>
prior_unresolved: [<ids of earlier findings you marked unresolved or rebuttal-rejected>]
---`;

const review = (rv: (typeof REVIEWERS)[number]) => `${CONTEXT}

ROLE
You are an ADVERSARIAL reviewer: ${rv.name}. Critique round ${ROUND}, reviewing design v${FROM} at ${D}/design-v${FROM}.md. Your job is to find the reasons this design will fail. Assume it is wrong until you have checked. You are one of three independent reviewers with different lenses; stay in your lens, but report anything severe you notice outside it.

YOUR LENS
${rv.lens}

PROCESS
1. Read the design doc fully (in chunks). Read the research digest; open full research reports and source whenever you need to verify a claim. If a finding depends on runtime behavior not already verified, run a minimal experiment in ${SP}/tmp-r${ROUND}-review-${rv.key}/.
2. Read ${D}/ledger.md and your earlier reviews ${PRIOR_ROUNDS.map((n) => `${D}/reviews/round-${n}-${rv.key}.md`).join(", ")}. For EVERY finding from round ${ROUND - 1} with id prefix ${rv.key}-r${ROUND - 1}-, and every earlier ${rv.key}- finding a previous round marked unresolved, set its status: resolved / unresolved / rebuttal-accepted / rebuttal-rejected ("unresolved" means the fix does not stop the original failure scenario). Also report, as a new finding, any earlier fix of yours that the latest revision broke again. Check that the fixes did not introduce new problems, contradictions or needless complexity.
3. Report NEW findings. Each MUST have a concrete failure scenario (specific inputs/state -> specific wrong outcome), evidence (source file:line, research report section, or experiment output) and a concrete suggested fix. No vague or stylistic nits, no padding; zero findings is a valid outcome. Do not re-report an earlier finding as new unless its fix is unresolved; then mark it unresolved AND add a new finding with the stronger evidence.
   Severity: blocker = violates a hard requirement or user decision, is a security hole, or rests on a wrong assumption that invalidates a component; major = significant correctness, extensibility (SOLID/OCP), DX or operability problem that needs a design change; minor = local improvement.
   Finding ids: ${rv.key}-r${ROUND}-NN.
4. Write your review to ${D}/reviews/round-${ROUND}-${rv.key}.md, saving as you go. This is the only file you may write in ${D}. It MUST start with this front matter, filled in (the orchestrator reads it):
${REVIEW_FRONT_MATTER(rv.key)}
   Then: summary, a table of prior-finding statuses, the findings (id, severity, section, title, failure scenario, evidence, suggested fix), and product questions you propose (options and a recommendation; only genuine trade-offs not already in §17).
5. verdict: 'approve' ONLY if no blocker or major findings remain from your lens (including unresolved prior ones); otherwise 'reject'.
When the file is complete, reply with one line: the verdict and the three counts.`;

const revise = `${CONTEXT}

ROLE
You are the lead architect. Critique round ${ROUND} of design v${FROM} produced three reviews: ${["BA", "NEST", "SEC"].map((k) => `${D}/reviews/round-${ROUND}-${k}.md`).join(", ")}. Read all three in full, then produce design v${TO}.

RULES
- ${
  values["continue-partial"]
    ? `AN EARLIER SESSION WAS INTERRUPTED during this revision after saving part of its work. ${D}/design-v${TO}.md already exists and ${D}/v${TO}-parts/ may be partly created. Do NOT copy design-v${FROM}.md over it. First diff design-v${TO}.md against design-v${FROM}.md and read the round ${ROUND} section of ${D}/ledger.md if one exists, to see which findings are already applied; check that work, then finish the rest in place, saving after every change.`
    : `FIRST, before anything else: copy design-v${FROM}.md to ${D}/design-v${TO}.md and work in place on the copy, saving after every change.`
} For whole-section rewrites, write part files under ${D}/v${TO}-parts/ and splice them with tools/splice.mts; before you finish, run tools/sync-parts.mts so ${D}/v${TO}-parts/ reproduces design-v${TO}.md.
- Address EVERY new finding (blocker, major and minor): ACCEPT (change the design) or REBUT (only with concrete evidence such as source file:line, a research citation or experiment output; reviewers judge rebuttals next round). A finding that is a genuine product trade-off becomes a §17 question with options and a recommendation, and is decided as recommended under the owner's standing decision; apply that option.
- Every prior finding a reviewer marked unresolved or rebuttal-rejected must be addressed the same way.
- §17 must show every product question as decided (keep its options and recommendation, and state that it was decided by the owner's standing decision of 2026-09-17), with no question left open. Update any text that calls a question open or pending (header, §0, §1).
- Prefer simplifying over adding mechanism when a finding shows a mechanism is fragile; the document is already large. Removing a feature is acceptable if the requirements and user decisions still hold, and it must be recorded in an ADR.
- Verify disputed facts against source before deciding; run a minimal experiment in ${SP}/tmp-r${ROUND}-revise/ if needed.
- Update the header, §1 traceability, §16 (ADRs: revised ones get a "Revised in v${TO}" line with finding ids; new ones cite the findings that forced them), §17 and a §18 changelog entry for v${TO}. Keep every section consistent; re-read the whole document once at the end and reconcile referenced ids against defined ids with a script.
- Append "Round ${ROUND} → design v${TO}" to ${D}/ledger.md: for each new finding id, its severity, reviewer, one-line title, your action and a one-line note ending with the ADR; then a table of the reviewers' prior-finding statuses.
- Do not silently drop requirements, user decisions or previously accepted fixes.
When done, reply with one line: how many findings you accepted and rebutted.`;

const AUDIT_FILE_RULE = (
  name: "ledger" | "xref",
) => `Write your result to ${D}/reviews/round-${ROUND}-audit-${name}.md, saving as you go; it is the only file you may write. It MUST start with this front matter, filled in:
---
audit: ${name}
round: ${ROUND}
audited: design-v${TO}.md
checked: <number>
gaps: <number of gaps>
---
Then one entry per gap: id, status (missing / partially-applied / contradicted / dangling-reference / placeholder / inconsistency), where (section and a short quote or line), problem, required change. When the file is complete, reply with one line: checked and gaps.`;

const auditLedger = `${CONTEXT}

ROLE
You are a ledger auditor. You check whether the fixes accepted in round ${ROUND} really landed in ${D}/design-v${TO}.md. You are NOT a design reviewer: do not raise new design criticism. Report only gaps between what was promised and what the document now says.

SCOPE
Every round-${ROUND} finding (ids *-r${ROUND}-NN) in ${D}/ledger.md with action accepted, plus every prior finding the reviewers marked unresolved or rebuttal-rejected. Findings in full: ${D}/reviews/round-${ROUND}-{BA,NEST,SEC}.md.

PROCESS
For EVERY finding in scope: read it and its ledger note; find where design-v${TO}.md implements the fix and read the surrounding section; decide whether the text as written stops the reviewer's exact failure scenario and whether every element the note names is present; search the rest of the document for statements that still describe the OLD behavior (code sketches, tables, ADRs, test cases). For rebutted findings, check only that the rebuttal is recorded with its evidence. Report a gap only when you can point at the place.

${AUDIT_FILE_RULE("ledger")}`;

const auditXref = `${CONTEXT}

ROLE
You are the cross-reference and consistency auditor for ${D}/design-v${TO}.md. You do not judge the design; you find mechanical and editorial defects.

PROCESS
1. With a script (run it from ${SP}/tmp-r${ROUND}-audit-XREF/), extract every identifier the document REFERENCES and every identifier it DEFINES: section numbers, ADR-nn, boot checks Bnn, invariants, RKnn, Qnn, LEAD-V/LEAD-EXP ids, error codes and warning codes, conformance and test case ids, exported symbol names in §2 versus names used later. Report undefined references, duplicate definitions and accidental gaps in numbered series.
2. Find placeholders (TODO, TBD, "see above" with no target) and leftover "Design v${FROM}" wording where v${TO} is meant.
3. Find contradictions between sections: the same option, default, decorator, token, boot check or error mapping described two ways (§2 API listing, §4 contracts, §5 options, §7-9 behavior, §13 error table, §14 cases, §15 migration, §16 ADRs, §17 questions).
4. Check that every §17 question has options, a recommendation and a decided status, every ADR changed in v${TO} cites finding ids, the v${TO} changelog entry exists, and \`pnpm exec tsx "${D}/tools/sync-parts.mts" design-v${TO}.md v${TO}-parts --check\` reports 0 differences.

${AUDIT_FILE_RULE("xref")}`;

const fix = `${CONTEXT}

ROLE
You are the lead architect. You wrote design v${TO}; two auditors compared it with the round-${ROUND} ledger and checked its cross-references. Their gaps are in ${D}/reviews/round-${ROUND}-audit-ledger.md and ${D}/reviews/round-${ROUND}-audit-xref.md. Close every gap in ${D}/design-v${TO}.md.

RULES
- Handle EVERY gap: fix it, or answer not-a-gap with the exact location that already covers it. Record the answer under each gap entry in the audit file ("Resolution: fixed ..." or "Resolution: not a gap ...").
- Verify before you change, then make the smallest edit that closes the gap everywhere the old statement appears.
- Afterwards re-run the reference check and \`pnpm exec tsx "${D}/tools/sync-parts.mts" design-v${TO}.md v${TO}-parts\` (then with --check). Keep ledger notes truthful. Save after every gap.
When done, reply with one line: how many gaps you fixed and how many were not gaps.`;

const out = resolve(CUR, requiredOption("out"));
mkdirSync(out, { recursive: true });
const files = {
  ...Object.fromEntries(
    REVIEWERS.map((rv) => [`review-${rv.key}.md`, review(rv)]),
  ),
  "revise.md": revise,
  "audit-ledger.md": auditLedger,
  "audit-xref.md": auditXref,
  "fix.md": fix,
};
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(out, name), `${text}\n`);
}
console.log(`wrote ${Object.keys(files).length} prompts to ${out}`);
