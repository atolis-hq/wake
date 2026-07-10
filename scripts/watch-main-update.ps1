param(
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent),
  [string]$WakeHome = (if ($env:WAKE_HOME) { $env:WAKE_HOME } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE "wake-home" } else { "" }),
  [int]$IntervalSeconds = (if ($env:WAKE_UPDATE_INTERVAL_SECONDS) { [int]$env:WAKE_UPDATE_INTERVAL_SECONDS } else { 90 }),
  [switch]$Once
)

$ErrorActionPreference = "Stop"

function Write-Log {
  param([string]$Message)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "[$timestamp] $Message"
}

function Get-TrimmedGitOutput {
  param(
    [string]$Root,
    [string[]]$Args
  )

  return (git -C $Root @Args).Trim()
}

if ([string]::IsNullOrWhiteSpace($WakeHome)) {
  throw "Wake home path is not set. Set WAKE_HOME or pass -WakeHome."
}

$updateScript = Join-Path $WakeHome "update.sh"

if (-not (Test-Path -LiteralPath $RepoRoot)) {
  throw "Repo root does not exist: $RepoRoot"
}

if (-not (Test-Path -LiteralPath $updateScript)) {
  throw "Wake update script does not exist: $updateScript"
}

do {
  try {
    $branch = Get-TrimmedGitOutput -Root $RepoRoot -Args @("rev-parse", "--abbrev-ref", "HEAD")
    if ($branch -ne "main") {
      Write-Log "skip: branch is $branch"
    } else {
      $status = git -C $RepoRoot status --porcelain --untracked-files=normal
      if ($status) {
        Write-Log "skip: working tree has local changes"
      } else {
        git -C $RepoRoot fetch origin main | Out-Null

        $localCommit = Get-TrimmedGitOutput -Root $RepoRoot -Args @("rev-parse", "HEAD")
        $remoteCommit = Get-TrimmedGitOutput -Root $RepoRoot -Args @("rev-parse", "origin/main")

        if ($localCommit -eq $remoteCommit) {
          Write-Log "no change"
        } else {
          Write-Log "change detected; pulling main"
          git -C $RepoRoot pull --ff-only origin main

          $updatedCommit = Get-TrimmedGitOutput -Root $RepoRoot -Args @("rev-parse", "HEAD")
          if ($updatedCommit -ne $remoteCommit) {
            throw "Pull completed but HEAD ($updatedCommit) does not match origin/main ($remoteCommit)."
          }

          Write-Log "running wake update"
          & bash $updateScript --keep-prompts

          if ($LASTEXITCODE -ne 0) {
            throw "Wake update failed with exit code $LASTEXITCODE."
          }

          Write-Log "update complete at $updatedCommit"
        }
      }
    }
  } catch {
    Write-Log "error: $($_.Exception.Message)"
  }

  if (-not $Once) {
    Start-Sleep -Seconds $IntervalSeconds
  }
} while (-not $Once)
