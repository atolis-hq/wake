<#
.SYNOPSIS
  Seeds GitHub issues in atolis-hq/wake-test with the labels and assignee
  needed to exercise each fake-runner scenario configured in
  fake-scenarios.yaml, via the intake rules in a wake-next config.yaml.

.DESCRIPTION
  Creates one issue per workflow selector so a resident `wake start`/`tick`
  loop picks each of them up on its own workflow:
    - wake-next-verify                                -> default workflow
    - wake-next-verify, approval                       -> approval workflow
    - wake-next-verify, fake-scenario-test             -> fake-scenario-test workflow
    - wake-next-verify, dark-factory-test              -> dark-factory workflow

  This script only creates issues (labels + assignee) — it does not run
  Wake, poll for completion, or close anything afterwards.

.PARAMETER Repo
  GitHub "owner/repo" to create issues in. Defaults to atolis-hq/wake-test,
  matching wake-next's config.yaml integrations.github.repositories.

.PARAMETER Assignee
  GitHub login to assign each issue to. Defaults to atolis-hq-agent,
  matching wake-next's config.yaml requiredAssignees.

.EXAMPLE
  ./scripts/seed-fake-scenario-issues.ps1
#>

param(
  [string]$Repo = 'atolis-hq/wake-test',
  [string]$Assignee = 'atolis-hq-agent'
)

$ErrorActionPreference = 'Stop'

function Test-GhCommand {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'gh CLI not found on PATH. Install https://cli.github.com/ and run `gh auth login` first.'
  }
}

function Confirm-Label {
  param([string]$Label)

  try {
    gh label create $Label --repo $Repo --color 'BFD4F2' --description 'Wake fake-scenario seed label' 2>$null | Out-Null
  } catch {
    # Label already exists or caller lacks permission; issue creation below fails clearly if unusable.
  }
}

function New-ScenarioIssue {
  param(
    [string]$Name,
    [string[]]$Labels,
    [string]$Body
  )

  $title = "Wake fake-scenario seed: $Name ($(Get-Date -Format o))"
  $labelArgs = $Labels | ForEach-Object { '--label', $_ }
  $bodyFile = New-TemporaryFile
  try {
    Set-Content -Path $bodyFile -Value $Body -Encoding UTF8 -NoNewline

    $url = gh issue create `
      --repo $Repo `
      --title $title `
      --body-file $bodyFile `
      --assignee $Assignee `
      @labelArgs

    if ($LASTEXITCODE -ne 0) {
      throw "Failed to create issue for scenario '$Name'"
    }
  } finally {
    Remove-Item -Path $bodyFile -Force -ErrorAction SilentlyContinue
  }

  [PSCustomObject]@{ Scenario = $Name; Labels = ($Labels -join ', '); Url = $url }
}

Test-GhCommand

$scenarios = @(
  @{
    Name   = 'default'
    Labels = @('wake-next-verify')
    Body   = @'
What should happen: this issue is picked up by the **default** workflow
(refine -> implement, both on the `standard`/`light` runner pool, which
resolves to the `fake` runner). A stage's `done` route requires human
approval by default unless it opts out, so both stages here pause for a
human reply — this is the same behavior as the **approval** workflow
below, just reached implicitly rather than via an explicit `await`.

Expected sequence:
1. Wake stamps this issue into the `refine` stage and starts a run. The
   board should show an active-run child card (refine running) for
   about 20s (delayed by the `fake/refine` rule in fake-scenarios.yaml).
2. That run finishes `DONE` and Wake stops and waits — the issue should
   show as awaiting the `approved` signal rather than auto-advancing to
   `implement`.
3. A human must reply `/approved` before Wake proceeds. Wake then runs
   `implement`, again showing an active-run card for about 20s (the
   `implement-fake` rule).
4. That run finishes `DONE` and Wake again waits for a second `/approved`
   reply before moving the issue to `done`.
'@
  },
  @{
    Name   = 'approval'
    Labels = @('wake-next-verify', 'approval')
    Body   = @'
What should happen: this issue is picked up by the **approval** workflow
(refine -> implement, both gated on a human `approved` signal).

Expected sequence:
1. Wake runs `refine` (fake runner, ~20s active-run card), finishes
   `DONE`, then stops and waits — the issue should show as blocked/awaiting
   the `approved` signal rather than auto-advancing to `implement`.
2. A human must post the approval signal (per the approval workflow's
   `await` config) before Wake proceeds.
3. Once approved, Wake runs `implement` (fake runner, ~20s active-run
   card), finishes `DONE`, then again waits for a second `approved` signal
   before moving the issue to `done`.
'@
  },
  @{
    Name   = 'fake-scenario-test'
    Labels = @('wake-next-verify', 'fake-scenario-test')
    Body   = @'
What should happen: this issue is picked up by the **fake-scenario-test**
workflow, which only has a `refine` stage with `retry: { max: 1 }` on
failure.

Expected sequence:
1. First `refine` activation matches the `fail-first-refine` rule: after
   ~20s it fails with outcome `FAILED` and `retrySafety: safe-to-retry`.
2. Because the stage declares `retry: { max: 1 }`, Wake automatically
   retries `refine` instead of blocking.
3. Second `refine` activation matches `recover-on-retry`: after ~20s it
   succeeds `DONE`, and Wake stops and waits for approval — a stage's
   `done` route requires human approval by default, so a `/approved`
   reply is needed before the issue moves to `done` (this workflow has no
   `implement` stage).
4. You should see two consecutive ~20s active-run cards for `refine` on
   this issue, with a visible failed-then-retried run history, then one
   human `/approved` reply to finish.
'@
  },
  @{
    Name   = 'dark-factory-test'
    Labels = @('wake-next-verify', 'dark-factory-test')
    Body   = @'
What should happen: this issue is picked up by the **dark-factory**
workflow, which gates both `refine` and `implement` on a `watchGates`
route — each stage spawns a review watch and waits for that watch's
own verdict to arrive back through a real GitHub comment before
advancing.

Expected sequence:
1. Wake runs `refine` on `fake-worker` (~20s active-run card, outcome
   `DONE` via the `refine-fake-worker` rule), then waits on the
   `plan-review` watchGate.
2. The `plan-review` watch spawns its own workflow instance: first
   activation matches `fail-first-plan-review` (~20s, `FAILED`,
   safe-to-retry — a technical failure, retried automatically within
   that child), second activation matches `recover-plan-review-on-retry`
   (~20s, `DONE` — a real verdict). That child's own run-completion
   comment on this issue carries a `wake.watchGateVerdict` JSON marker;
   once Wake polls and observes that comment, the parent's `plan-review`
   gate resolves and the issue advances to `implement`.
3. Wake runs `implement` on `fake-worker` (~20s, `DONE` via
   `implement-fake-worker`), then waits on the `pr-review` watchGate.
4. The `pr-review` watch spawns its own workflow instance: `pr-review-approves`
   (~20s, `DONE`) posts its own verdict marker; once observed, the
   `pr-review` gate resolves and the issue moves to `done`.
5. A human (or an external reviewer) can also resolve either gate
   directly by commenting `/approved` or `/changes` on this issue —
   the same override Wake already recognizes for the plain `approval`
   workflow.
'@
  }
)

$allLabels = $scenarios | ForEach-Object { $_.Labels } | Select-Object -Unique
foreach ($label in $allLabels) {
  Confirm-Label -Label $label
}

$results = foreach ($scenario in $scenarios) {
  New-ScenarioIssue -Name $scenario.Name -Labels $scenario.Labels -Body $scenario.Body
}

$results | Format-Table -AutoSize
