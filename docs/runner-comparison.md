# Runner Comparison

This page documents the current behavioral contract of Wake's real runner
adapters and, just as importantly, where the contract is not yet portable
across CLIs.

Wake normalizes all real runners behind `AgentRunner`, `smoke`, and
`sandbox resume`, but some controls remain CLI-specific.

## Summary

| Feature / Control | Claude runner | Codex runner | Cursor runner | Notes |
|---|---|---|---|---|
| `runner.mode` support | Yes | Yes | Yes | All three are first-class runtime modes. |
| Normalized `AgentRunResult` into `core/` | Yes | Yes | Yes | All return `result`, `model`, `cli`, optional `session_id`, and failure metadata. |
| Stage prompt templates | Yes | Yes | Yes | All use the shared Wake prompt templates. |
| Action-specific model overrides | Yes | Yes | Yes | `runner.<cli>.models.<action>` works for all. |
| Wall-clock timeout | Yes | Yes | Yes | All runners kill hung CLI processes and return `FAILED`. |
| `wake smoke` support | Yes | Yes | Yes | All support the generic smoke surface. |
| Explicit smoke command | `smoke claude` | `smoke codex` | `smoke cursor` | All supported. |
| Session resume command generation | `claude --resume <id>` | `codex resume <id>` | `cursor agent --resume=<id>` | All supported in `wake sandbox resume` and GitHub comments. |
| Stage-specific access control | Per-tool allowlist | Sandbox mode | `--mode ask` / default | Mechanisms differ; all separate refine from implement. |
| Parsed raw CLI output in metadata | Yes | Yes | Yes | Claude: parsed JSON; Codex: parsed JSONL; Cursor: parsed JSON. |
| Run correlation logging | Yes | Yes | Yes | All emit start/success/failure log lines. |

## Control-Level Comparison

| Control | Claude | Codex | Cursor | Current Wake behavior |
|---|---|---|---|---|
| Max-turn cap | Supported | Not supported | Not supported | Wake enforces `maxTurns` for Claude only. Codex and Cursor read the same prompt templates but cannot enforce a CLI turn cap. |
| Per-tool allowlist | Supported | Not supported | Not supported | Claude enforces `allowedTools`; Codex and Cursor rely on prompt instructions plus mode/sandbox controls. |
| Permission / approval policy | Supported | Supported | Supported | Claude: permission mode flags; Codex: `--ask-for-approval never`; Cursor: `--force` for implement. |
| Read-only refine enforcement | `allowedTools` (per-tool) | `--sandbox workspace-write` (filesystem) | `--mode ask` (CLI-enforced read-only) | All three restrict refine differently; Cursor's `--mode ask` is CLI-enforced at the agent level. |
| Remote-control smoke automation | Supported | Not supported from CLI | Not supported from CLI | Claude has a CLI remote-control path. Codex and Cursor remote control are app-driven. |
| Session naming | Supported | Not supported | Not supported | Claude stamps `sessionName`; Codex and Cursor `exec`/`agent` do not expose equivalent naming flags. |

## Practical Consequences

### Refine-stage confinement

**Claude refine** is the most granular because Wake can pass an explicit tool
allowlist and deny edit tools at the CLI boundary.

**Codex refine** is a middle ground:
- Wake passes a Codex-specific capability note about shell read commands
- Wake selects the less-permissive Codex sandbox mode (`workspace-write`)
- Codex cannot be told "only read-only shell commands" at per-tool granularity

**Cursor refine** uses `--mode ask` which is a CLI-enforced read-only mode:
- The Cursor CLI itself refuses write operations in ask mode
- Wake also passes a Cursor-specific capability note explaining ask mode
- This provides CLI-level enforcement without per-tool granularity

**Cursor implement** omits `--mode` entirely, using Cursor's default agent mode
which allows file edits, and passes `--force` to auto-approve writes.

### Turn budgeting

Wake prompt templates carry `maxTurns`, and Claude enforces that with a real
CLI flag. Codex and Cursor currently have no documented equivalent, so their
runs depend on:

- the prompt's completion contract
- the outer wall-clock timeout
- the CLI's own completion behavior

### Remote control

Wake exposes `smoke claude -- --remote-control` because Claude has a CLI flow
for that path. Codex and Cursor remote access are documented as desktop app
setups, not CLI setups, so Wake does not expose remote-control smoke paths
for those runners.

## What Wake deliberately does not fake

Wake does not pretend unsupported controls exist.

Specifically, Wake does not:

- invent a fake `maxTurns` layer for Codex or Cursor
- advertise per-tool enforcement for Codex or Cursor when only mode-level controls exist
- expose fake remote-control smoke paths for Codex or Cursor
- claim session naming parity for Codex or Cursor that their CLIs do not provide

## Credential bind-mounts (Docker sandbox)

Each CLI stores credentials in a specific location that can be bind-mounted
from the host machine into the container (recommended to avoid re-authenticating
on every container rebuild):

| CLI | Host credential path | Container path | Notes |
|---|---|---|---|
| Claude Code | `~/.claude` | `/home/wake/.claude` | Add to `sandbox.extraMounts` with `readOnly: false` |
| Codex | `~/.codex` | `/home/wake/.codex` | Add to `sandbox.extraMounts` with `readOnly: false` |
| Cursor | `~/.cursor` | `/home/wake/.cursor` | Add to `sandbox.extraMounts` with `readOnly: false` |

Example `config.json` extraMounts for all three:

```json
"extraMounts": [
  { "source": "~/.claude", "target": "/home/wake/.claude" },
  { "source": "~/.codex",  "target": "/home/wake/.codex"  },
  { "source": "~/.cursor", "target": "/home/wake/.cursor"  }
]
```

## Sources

These parity notes were checked against the installed CLI surface and official
docs:

- Codex CLI command reference: https://developers.openai.com/codex/cli/reference
- Codex config basics: https://developers.openai.com/codex/config-basic
- Codex config reference: https://developers.openai.com/codex/config-reference
- Cursor CLI headless mode: https://cursor.com/docs/cli/headless
- Cursor CLI output format: https://cursor.com/docs/cli/reference/output-format
- Cursor CLI overview: https://cursor.com/docs/cli/overview
