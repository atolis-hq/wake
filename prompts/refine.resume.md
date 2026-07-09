---
stage: refine
mode: resume
permissionMode: default
allowedTools: Read, Glob, Grep, Bash(git fetch), Bash(git status)
extraArgs:
maxTurns: 40
skipApproval: false
---
Resuming the REFINE stage session for {{workItemKey}}.

{{toolCapabilityNote}}

You may run `git fetch origin` to ensure the canonical clone is up-to-date,
and `git status` to inspect repository state. If any git operation results in
merge conflicts, cancel the action and return BLOCKED rather than attempting
to resolve conflicts.

New comments since your last turn (excludes Wake/bot comments):
Wake will provide them below in a delimited untrusted data block.

Re-evaluate whether the issue is now well-specified enough to implement,
incorporating the new context above.
