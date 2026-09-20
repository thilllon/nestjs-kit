# Import provenance

This workspace imports the substantive work from `thilllon/nestjs-slightly-better-auth` at commit `4614edfe1f2876e1f6054219479e713fc3b57cfb`. The local checkout was clean at `ac7f96fb4eef4945db497fc6a785acd45581871c`; the imported snapshot includes those files plus ten subsequent design-review commits. The original repository and local checkout were not modified.

## Preserved work

| Original material                                                | Monorepo location                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Entry point, license and changelog                               | Package root and `src/`                                                 |
| Design versions 1–6, section parts, research, reviews and ledger | `docs/design/`                                                          |
| Legacy adapter source and E2E tests                              | `legacy/`, with test helpers renamed to `fixtures/`                     |
| Standalone agent instructions                                    | `docs/archive/standalone-agents.md`                                     |
| Autopilot procedure, log and state                               | `docs/archive/autopilot-*` historical snapshots                         |
| Nonportable local review workflow                                | `docs/design/reference/review-round.workflow.js.txt`                    |
| Design editing and prompt utilities                              | `docs/design/tools/*.mts`, adapted for `tsx` and package-relative paths |
| Packaging tests                                                  | `src/packaging.test.ts`, adapted to run after the shared build          |

Shared workspace configuration replaces the original standalone lockfile, CI/release workflows, Dependabot, mise, hooks, formatter and compiler/build/test configs. The README and active agent instructions describe this repository's workflow. The original files remain in source commit history; duplicate active pipelines would conflict with protected PRs and independent Changesets releases.

## Status at import

The source entry point exports nothing. Design v6 has been reviewed in round 6, but its findings still require revision. Historical changelog text about reserving or publishing the name is not proof of npm publication: the registry returned 404 during integration. This workspace therefore retains version `0.0.1` and sets `private: true`.

Historical designs contain proposed APIs and version ranges, old script commands and paths to temporary experiments. They are evidence of the design process, not supported public API documentation or proof that those experiments can still run. Current package instructions take precedence over old injection helpers and standalone operational instructions.

## Automation boundary

Archived instructions and lock records are inactive reference documents here. No scheduler is registered or retargeted by copying them. Any external routine still targeting the original repository needs separate owner-side retirement or retargeting; this import does not claim to disable it.

## Licensing

The package and its original design work remain MIT licensed under the package `LICENSE`. The legacy upstream source also retains the original Thalles Passos MIT notice in `legacy/LICENSE`. The monorepo's ISC license does not replace either notice.
