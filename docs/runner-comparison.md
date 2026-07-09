# Runner Comparison

This page documents the current behavioral contract of Wake's real runner
adapters and, just as importantly, where the contract is not yet portable
across CLIs.

Wake normalizes both real runners behind `AgentRunner`, `smoke`, and
`sandbox resume`, but some controls remain Claude-only because the Codex CLI
does not expose equivalent local flags or automation surfaces today.

## Summary

| Feature / Control | Claude runner | Codex runner | Notes |
|---|---|---|---|
| `runner.mode` support | Yes | Yes | Both are first-class runtime modes. |
| Normalized `AgentRunResult` into `core/` | Yes | Yes | Both return `result`, `model`, `cli`, optional `session_id`, token usage, and failure metadata. |
| Stage prompt templates | Yes | Yes | Both use the shared Wake prompt templates. |
| Action-specific model overrides | Yes | Yes | `runner.<cli>.models.<action>` works for both. |
| Wall-clock timeout | Yes | Yes | Both runners kill hung CLI processes and return `FAILED`. |
| `wake smoke` support | Yes | Yes | Both support the generic smoke surface. |
| Explicit smoke command | `smoke claude` | `smoke codex` | Both supported. |
| Session resume command generation | `claude --resume <id>` | `codex resume <id>` | Both supported in `wake sandbox resume` and GitHub comments. |
| Stage-specific sandbox mode | Partial | Partial | Claude relies more on tool allowlists; Codex relies more on sandbox mode. |
| Parsed raw CLI output in metadata | Yes | Yes | Claude stores parsed JSON object; Codex stores parsed JSONL event list. |
| Run correlation logging | Yes | Yes | Both emit start/success/failure log lines. |

## Control-Level Comparison

| Control | Claude | Codex | Current Wake behavior |
|---|---|---|---|
| Max-turn cap | Supported | Not supported | Wake enforces `maxTurns` for Claude only. Codex reads the same prompt templates but cannot enforce a CLI turn cap. |
| Per-tool allowlist | Supported | Not supported for the local coding toolset | Claude enforces `allowedTools`; Codex uses prompt instructions plus sandbox mode, but cannot block specific local tools like `Edit` or `Write` with a documented CLI flag. |
| Permission / approval policy | Supported | Supported | Claude uses its own CLI permission flags; Codex uses `--ask-for-approval never` in non-interactive runs. |
| Sandbox level selection | Limited / implicit in current Wake usage | Supported | Wake currently maps Codex refine to `workspace-write` and implement to `danger-full-access`. This is the best approximation to Claude's stage separation, but not a true per-tool equivalent. |
| Remote-control smoke automation | Supported | Not supported from the CLI | Claude exposes a CLI remote-control smoke path. Codex remote control is app-driven, so Wake does not expose `smoke codex --remote-control`. |
| Session naming | Supported | Not supported | Claude can stamp `sessionName` / `remoteControlName`; Codex `exec` does not expose an equivalent naming flag. |

## Practical Consequences

### Refine-stage confinement

Claude refine is the stricter implementation today because Wake can pass an
explicit tool allowlist and deny edit tools at the CLI boundary.

Codex refine is a middle ground:

- the shared prompt still says refine is planning-only
- Wake selects the less-permissive Codex sandbox mode (`workspace-write`)
- but Codex cannot be told "only Read/Glob/Grep/git fetch/git status" with a
  documented local CLI flag

That means Codex refine is safer than full-access implementation, but not as
strictly confined as Claude refine.

### Turn budgeting

Wake prompt templates carry `maxTurns`, and Claude enforces that with a real
CLI flag. Codex currently has no documented `exec` equivalent, so Codex runs
depend on:

- the prompt's completion contract
- the outer wall-clock timeout
- the CLI's own completion behavior

### Remote control

Wake exposes `smoke claude -- --remote-control` because Claude has a CLI flow
for that path. Codex remote access is documented as a Codex App setup, not a
Codex CLI setup, so Wake does not currently claim parity there.

## What Wake deliberately does not fake

Wake does not pretend unsupported Codex controls exist.

Specifically, Wake does not:

- invent a fake `maxTurns` layer for Codex
- advertise Codex per-tool enforcement when only prompt guidance exists
- expose a fake Codex CLI remote-control smoke path
- claim Codex session naming parity that the CLI does not provide

## Sources

These parity notes were checked against both the installed CLI surface and the
official OpenAI Codex docs:

- Codex CLI command reference: https://developers.openai.com/codex/cli/reference
- Codex config basics: https://developers.openai.com/codex/config-basic
- Codex config reference: https://developers.openai.com/codex/config-reference
- Codex remote connections: https://developers.openai.com/codex/remote-connections
