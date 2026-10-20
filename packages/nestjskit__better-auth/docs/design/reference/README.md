# Historical workflow reference

`review-round.workflow.js.txt` preserves the original standalone design workflow
source without making it executable. It depended on an external agent workflow
runtime, undeclared runtime globals, and machine-specific scratch directories that
are no longer available.

For portable prompt generation, use [`../tools/prompts.mts`](../tools/prompts.mts).
Rendering prompts does not start agents, change designs, commit files, or publish
packages. The monorepo's root `AGENTS.md` governs any work performed from those prompts.
