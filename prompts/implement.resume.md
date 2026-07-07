---
stage: implement
mode: resume
permissionMode: acceptEdits
allowedTools: Bash(git *), Bash(gh *), Bash(npm *), Edit, Write, Read, Glob, Grep
extraArgs:
maxTurns: 150
---
Resuming the IMPLEMENT stage session for {{workItemKey}}.

Your current working directory is still the git checkout of {{repo}} on
branch {{branch}}. Continue from where you left off rather than starting
over, unless the new comments below change the approach.

New comments since your last turn (excludes Wake/bot comments):
{{newCommentsText}}

Reminder of the completion requirements: commit, push {{branch}}, open a PR
with `gh pr create` closing #{{issueNumber}}, and never merge it yourself.

Respond concisely. The last line of your response must be exactly one of:
DONE, BLOCKED, FAILED.
