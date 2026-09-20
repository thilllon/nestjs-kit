> Historical snapshot from the standalone repository. These are not active
> instructions in nestjs-kit; follow the repository and package AGENTS.md instead.

# Autopilot procedure

This repository is built by a cloud routine that wakes up every hour and follows this file.
The owner does not watch the runs. Each run moves the project forward by as many steps as
it can finish, pushes every finished step to `main`, and leaves the next step to the next
run. `state.json` next to this file says where the work stands; `log.md` is the run log the
owner reads.

## Standing rules from the owner

- Push every finished step to `main` right away. No pull requests for this work.
- Every product question is decided as its recommended option, including questions that
  come up later. Record each decision where the question lives (design §17, or the plan).
  Never stop to ask.
- The design is finished before code is written: three adversarial reviewers review each
  version until all three approve (see "Stage: design" for the one exception).
- Commit messages carry no `Co-Authored-By` trailer.
- Everything in `AGENTS.md` applies, including `mise exec -- pnpm check` before every
  push that touches code, configs or tests.

## 1. Start of every run

1. Sync: `git fetch origin && git checkout main && git pull --rebase origin main`.
2. Read `docs/autopilot/state.json`.
   - `stage` is `done` or `blocked`: append nothing, change nothing, and end the run. Only
     the owner clears `blocked`.
   - `lock` is set and `lock.heartbeat` is less than 3 hours old: another run is working.
     End the run without changing anything.
   - Otherwise take the lock: set `lock` to `{ "run": "<UTC start time>", "heartbeat":
"<UTC now>" }`. If the old lock was stale, say so in the log entry. Commit
     `chore(autopilot): take the lock` and push. If the push is rejected, pull with rebase
     and start again at step 2.
   - **Retry limit.** `attempts` (missing means 0) counts how many runs started the step
     `state.json` names without finishing it. When the old lock was stale (an earlier run died), add 1. When
     `attempts` reaches 3, set `stage` to `blocked`, write the step and the likely cause to
     `log.md`, release the lock, push, and end the run. A finished step resets `attempts`
     to 0.
3. Set up the tools (every run starts from a clean machine):
   - Node.js 24 and pnpm 11.27.0: use `mise install` when mise exists; otherwise
     `corepack enable && corepack prepare pnpm@11.27.0 --activate` on the preinstalled
     Node.js (it must be 22.13 or newer). Then `pnpm install --frozen-lockfile`. Without
     mise, run every `mise exec -- <command>` from `AGENTS.md` and this file as `<command>`.
   - Reference sources, read-only, for the design stage:
     `git clone --depth 1 --branch v1.7.4 https://github.com/better-auth/better-auth.git /tmp/nsba/better-auth`
     and `git clone https://github.com/ThallesP/nestjs-better-auth.git /tmp/nsba/ref && git -C /tmp/nsba/ref checkout 99d4a94`.
     If a setup step fails, record the exact error in the log, release the lock, push, and
     end the run. Do not work around a broken toolchain by skipping checks.

## 2. Working and checkpointing

- Do the step that `state.json` names, then the next one, for as long as the session
  lasts. A session can end at any moment, so finish each step with a checkpoint:
  1. update `state.json` (the next step, and `lock.heartbeat` set to now);
  2. append one line to `log.md`: `- <UTC time> <what was finished, with counts>`;
  3. commit with a message that says what the step produced, and push.
- Every push can be rejected because another commit landed first: pull with rebase and
  push again.
- Run subagents with the Agent tool. Give each one the rendered prompt file's full text
  as its prompt. Launch parallel subagents in a single message. Subagents never commit;
  this session does.
- Subagents run in the background, and you are notified as each one finishes. Commit and
  push each subagent's output file as soon as that subagent finishes (with a heartbeat
  update), without waiting for the others, so a session that ends early loses as little
  as possible. A later run reruns only the subagents whose files are missing or
  incomplete.
- After a subagent finishes, check the file it had to write (front matter present and
  filled in). Run a subagent again when its file is missing or incomplete; after two
  failures, log it and end the run with the lock released.
- Before ending the run, release the lock (`"lock": null`), commit and push.

## 3. Stage: design

`state.design` holds `round`, `from` (the version under review), `to` (the version the
revision writes) and `phase`. Render the prompts for the current round first:

```sh
node docs/design/tools/prompts.mjs --round <round> --from <from> --to <to> --out /tmp/nsba/prompts
```

Add `--continue-partial` when `docs/design/design-v<to>.md` already exists (an earlier run
was interrupted during the revision).

| Phase    | Subagents                                                      | Output                                                            | Next phase                              |
| -------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| `review` | `review-BA.md`, `review-NEST.md`, `review-SEC.md`, in parallel | `docs/design/reviews/round-<round>-{BA,NEST,SEC}.md`              | converged → stage `plan`; else `revise` |
| `revise` | `revise.md`                                                    | `design-v<to>.md`, `v<to>-parts/`, a round section in `ledger.md` | `audit`                                 |
| `audit`  | `audit-ledger.md`, `audit-xref.md`, in parallel                | `reviews/round-<round>-audit-{ledger,xref}.md`                    | gaps → `fix`; none → round done         |
| `fix`    | `fix.md`                                                       | edits to `design-v<to>.md`                                        | round done                              |

- **Converged** means all three reviews have `verdict: approve` and `blockers: 0` and
  `majors: 0`.
- **Also leave the design stage** when `round` is 8 or more and the latest round had no
  blocker: record the open major findings as residual risks in §17 of the current design
  (one line each, with the finding id), mark the design final, and continue with `plan`.
  This keeps the project moving; the plan must then cover those risks with tests.
- **Round done:** check `node docs/design/tools/sync-parts.mjs docs/design/design-v<to>.md docs/design/v<to>-parts --check`,
  add the round's row to the status table in `docs/design/README.md` and point it at the new
  version, then set `round` +1, `from` = `to`, `to` +1, `phase` = `review`. Commit
  `docs: design v<to> from review round <round>` and push.
- Commit after every phase, for example `docs: round 5 reviews of design v5 (3 x reject,
0 blockers, 4 majors)`.

## 4. Stage: plan

Input: the final design (`docs/design/design-v<from>.md` that converged).

1. One subagent (the lead architect) writes `docs/implementation/plan.md`: an ordered list
   of vertical slices `S01`, `S02`, ... Each slice names its goal, the design sections it
   implements, the files it adds or changes, the tests that prove it (unit, e2e on Express
   and Fastify where it applies, packaging) and its done criteria. A slice must fit in one
   session: about one design unit. Start with the package layout and exports, then the
   kernel, then each extension unit in dependency order. Each slice has a
   `Status: todo` line.
2. One subagent reviews the plan adversarially (NestJS and better-auth lens): missing design
   requirements, wrong order, slices too large to finish in a session, untestable done
   criteria. It writes `docs/implementation/plan-review.md`.
3. The lead architect applies the review to the plan.
4. Commit `docs: implementation plan` and push. Set `stage` to `implement` and
   `implementation.next` to the first slice.

## 5. Stage: implement

For the slice `implementation.next`:

1. One implementation subagent builds the slice test-first against the design sections it
   names: write the tests, watch them fail, implement, and run `mise exec -- pnpm check`
   until it is green. It follows `AGENTS.md` and the design exactly; when the design is
   wrong or silent, it takes the option the design's principles favor and records that in
   the slice's notes in `plan.md`.
2. One review subagent reviews the diff (`git diff`) for correctness against the design,
   security, and SOLID, and lists concrete defects with file and line.
3. The implementation subagent fixes every defect, or answers it with evidence, and runs
   `pnpm check` again.
4. When the slice changes what the package ships, add a changeset without bumping the
   version: `pnpm changeset add --minor nestjs-slightly-better-auth -m "<what users get>"`
   (`--patch` for fixes). Releasing stays with the owner.
5. Set the slice to `Status: done` in `plan.md`, set `implementation.next` to the next
   slice, commit `feat: <slice goal> (S<nn>)` and push. The pre-push hook runs the check
   again.
6. Continue with the next slice while the session lasts.

When a slice shows the design itself is wrong in a way that affects other slices, fix the
design text with the smallest change, note it in the latest design's §18 changelog as an
implementation-time correction, and continue.

When no slice is left, set `stage` to `done`, append a summary to `log.md`, release the
lock, commit and push.
