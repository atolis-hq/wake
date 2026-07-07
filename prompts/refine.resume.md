---
stage: refine
mode: resume
permissionMode: default
allowedTools: Read, Glob, Grep, Bash(git fetch), Bash(git status)
extraArgs:
maxTurns: 40
requiresApproval: true
---
Resuming the REFINE stage session for {{workItemKey}}.

Reminder: this is still a planning-only stage - your only available tools
are: {{allowedToolsList}}. Do not attempt to use Edit, Write, or any Bash
command other than the git commands listed above, or modify any file.

You may run `git fetch origin` to ensure the canonical clone is up-to-date,
and `git status` to inspect repository state. If any git operation results in
merge conflicts, cancel the action and return BLOCKED rather than attempting
to resolve conflicts.

New comments since your last turn (excludes Wake/bot comments):
{{newCommentsText}}

Re-evaluate whether the issue is now well-specified enough to implement,
incorporating the new context above. Respond concisely. The last line of
your response must be exactly one of: DONE, BLOCKED, FAILED{{additionalSentinels}}.
{{approvalInstructions}}
