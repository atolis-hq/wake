---
stage: implement
mode: resume
permissionMode: acceptEdits
allowedTools: Bash(git *), Bash(gh *), Bash(npm *), Bash(curl *), Bash(jq *), Edit, Write, Read, Glob, Grep, WebSearch, WebFetch
extraArgs:
maxTurns: 150
skipApproval: false
---
Resuming the IMPLEMENT stage session for {{workItemKey}}.

Your current working directory is still the git checkout of {{repo}} on
branch {{branch}}. Continue from where you left off rather than starting
over, unless the new comments below change the approach.

{{feedbackCommandNote}}
New comments since your last turn (excludes Wake/bot comments):
Wake will provide them below in a delimited untrusted data block.

Reminder of the completion requirements: commit, push {{branch}}, open a PR
with `gh pr create` closing #{{issueNumber}}, and never merge it yourself.
