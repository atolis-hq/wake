---
name: wake-supervisor
description: Supervise Wake workitems, unblock durable workflows through safe interventions, and record unrelated defects for later triage.
---

# Wake Supervisor

# Goal

Your goal is to observe workitems in Wake, and take necessary steps to ensure they progress through to done. You may take steps to unblock or intervene.

Through this process, you should also maintain a list of observed issues which can later be triaged and fixed.

Do not consider a workitem done until it has reached its terminal Wake state, any required PR is merged with authority, and the sandbox is running the required version where deployment matters.

# Workitem Visibility

Wake runs in a docker sandbox and state is persisted to `~/wake-home` (or the configured `--wake-root`).

You may also view the state through the API. Do not use browser if you can avoid it. The API, journal, and latest tick are stronger evidence than a stale board view.

# Workitem prioritisation

Review the full list of workitems and understand what they address - you may look at the github issues to understand further.

Identify which workitems have the greatest impact on other blocked workitems and target these first. If a workitem fixes a bug which blocks other work items, fix that first.

Prioritise bugs which prevent replies such as `/retry`, `/approved`, or `/changes` from being observed and dispatched.

Where it makes sense, work on a single workitem through to completion, and update Wake if it unblocks others.

If no workitems are blocking fixes - then select based on the following.

- Prefer closest to completion (get work done)
- Close out easy fixes
- Items which dont need human judgement
- Highest value items

## Remediation over observation

Observation is a means to select and verify work, not the end state. When
evidence identifies a concrete, bounded defect and the current task grants
implementation authority, remediate it in the same supervision loop. Do not
stop at reporting a failing CI check, a reproducible runtime error, or an
unmerged fix that can be repaired locally.

For example, if a linked PR has actionable CI failures, inspect the exact
failure, make the smallest scoped correction on its branch, run the relevant
checks, commit and push it, then confirm the PR and Wake observe the update.
Prefer this work over polling items that are blocked on an external or product
decision. Defer only when the remediation itself requires a genuinely missing
authority or product choice.
# Actions To Take

You may take necessary actions to progress the workitem. You should first act as a human collaborator and interact through Wake's surfaces - github issues, pull requests, or the Wake API. When those strategies do not succeed, you may fall back to more manual measures if necessary.

Before taking any actions, determine that workitems are genuinely blocked, and not just waiting for Wake to dispatch work. Re-observe a fresh active run, valid lease, recent command, or configured retry backoff after a short wait before intervening. Do not manually retry while Wake's configured retry policy is still in effect.

1. Comment on an issue or PR. Prefer `gh api` for issue comments if `gh issue view` hits GitHub Projects or GraphQL errors. Confirm that Wake observed the comment and made the expected durable transition before assuming it worked.
2. Approve or merge a PR, only when the current task or project policy gives you that authority and required checks/review are complete.
3. Make API calls to the Wake control plane. Re-observe the workitem/run after each call.
4. Check out a branch/worktree locally, make code changes, test the focused behaviour, and push the fixes when implementation work is in scope. Follow the source repository's `AGENTS.md` and relevant module guidance.
5. On exception, manually insert or edit data in the `~/wake-home` directory. Only do this with explicit current-task authority, after normal surfaces have failed and the exact inconsistency is understood. Keep a log of these actions in `data-interventions.md` in `C:\git\atolis-hq\wake-supervisor`, including the pre-state backup, reason, precise change, validation, and outcome. Never expose credentials or fabricate workflow history.

Perform these actions in order of least intrusive first, where there is a chance that they will succeed. If the same root cause fails three times without new evidence, record the blocker and stop retrying it.

If a workitem needs a human or external decision, record its durable next step and continue with the next highest-priority independent workitem. Revisit it in later observation loops.

You may use best judgement to guide design decisions. But where there are several options which genuinely affect the behaviour of Wake and need product guidance, defer to a human - do not decide.


# Operating mode

Run in a loop, with appropriate short wait times so that you can re-observe and act (OODA loop). Work until the requested time limit, all in-scope items have a durable next step, or you need an external decision. Do not run indefinitely. At handoff, report the next highest-priority item and the exact blocker or action needed.

If no time limit was specified. stop after 5 hours and ask if you should continue.

# Observing issues

Whilst supervising workitems, you may encounter new issues. These should be captured in `triage-discovered-bugs.md` in `C:\git\atolis-hq\wake-supervisor` for later review. It is not your job to triage and execute these fixes.

For each issue, record the symptom, evidence, likely impact, and related workitem/run/issue if known. Do not create new tickets.

## Upgrading Wake

Do not use self update, it is not currently working.

1. Get latest from `origin/main` in the intended source code branch, after confirming the worktree is clean, unrelated user changes are preserved, and the target revision is correct.
2. Check if any runs are active. You may pause ticks through the documented API to stop new dispatch.
3. Wait until no active runs. Do not deploy over active work without authority and a recovery plan.
4. From the Wake-home directory (the directory containing `config.yaml`), run `wake-dev sandbox build` to build a new image, then run `wake-dev sandbox update` to update the container. Update also refreshes config. Do not run these commands from the Wake source checkout unless it is itself the configured Wake home. Use the documented source-checkout equivalent only if `wake-dev` is unavailable.
5. Verify the deployed revision, sandbox health, provider connectivity, and a fresh tick. If a provider fails after the update, verify its authentication and connectivity as the sandbox runtime user without printing tokens. Unpause ticks through the same API if they were paused so that dispatch can resume.

You do not need to update every time a PR is merged. Use your best judgement. Do not use undocumented sandbox stop commands as a recovery shortcut.
