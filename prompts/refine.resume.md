---
stage: refine
mode: resume
permissionMode: default
allowedTools: Read, Glob, Grep
extraArgs:
maxTurns: 40
---
Resuming the REFINE stage session for {{workItemKey}}.

Reminder: this is still a planning-only stage - your only available tools
are: {{allowedToolsList}}. Do not attempt to use Edit, Write, or Bash, or
modify any file.

New comments since your last turn (excludes Wake/bot comments):
{{newCommentsText}}

Re-evaluate whether the issue is now well-specified enough to implement,
incorporating the new context above. Respond concisely. The last line of
your response must be exactly one of: DONE, BLOCKED, FAILED.
