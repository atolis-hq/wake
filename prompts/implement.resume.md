---
stage: implement
mode: resume
permissionMode: acceptEdits
allowedTools: Bash(git *), Bash(gh *), Bash(npm *), Edit, Write, Read, Glob, Grep
extraArgs:
maxTurns: 150
skipApproval: false
---
Resuming the IMPLEMENT stage session for {{workItemKey}}.

Your current working directory is still the git checkout of {{repo}} on
branch {{branch}}. Continue from where you left off rather than starting
over, unless the new comments below change the approach.

New comments since your last turn (excludes Wake/bot comments):
{{newCommentsText}}

Reminder of the completion requirements: commit, push {{branch}}, open a PR
with `gh pr create` closing #{{issueNumber}}, and never merge it yourself.

Respond concisely. End your response with a fenced `wake-result` JSON block,
then repeat the status word on its own final line for degraded-mode fallback.
The JSON `status` and final line must be exactly one of: {{sentinelList}}.
{{sentinelInstructions}}
