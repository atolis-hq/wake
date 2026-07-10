# Configuration

Wake's behavior is configured through a `configuration.json` file located at `.wake/configuration.json`. This document describes the configuration structure, properties, and defaults.

## Overview

The configuration file defines:
- Where Wake stores runtime data and state
- How the Docker sandbox is mounted and debugged
- How frequently the control plane checks for new work
- Which execution mode and CLI settings to use
- Which external sources (like GitHub) to monitor for work
- Policies for filtering and publishing work

All configuration uses `schemaVersion: 1`.

## Full Sample Configuration

```json
{
  "schemaVersion": 1,
  "paths": {
    "wakeRoot": ".wake",
    "promptsRoot": ".wake/prompts"
  },
  "sandbox": {
    "image": "wake-sandbox",
    "containerName": "wake-sandbox",
    "containerMountPath": "/wake",
    "containerHomeMountPath": "/home/wake",
    "extraMounts": []
  },
  "scheduler": {
    "intervalMs": 60000
  },
  "runners": {
    "fake": { "kind": "fake" },
    "claude-haiku": {
      "kind": "claude",
      "command": "claude",
      "model": "claude-haiku-4-5",
      "timeoutMs": 600000
    },
    "claude-opus": {
      "kind": "claude",
      "command": "claude",
      "model": "claude-opus-4-8",
      "timeoutMs": 1800000
    },
    "codex-standard": {
      "kind": "codex",
      "command": "codex",
      "model": "gpt-5.4",
      "timeoutMs": 1200000,
      "reasoningEffort": "medium"
    },
    "codex-flagship": {
      "kind": "codex",
      "command": "codex",
      "model": "gpt-5.5",
      "timeoutMs": 1800000,
      "reasoningEffort": "high"
    },
    "cursor-standard": {
      "kind": "cursor",
      "command": "cursor",
      "model": "claude-sonnet-4-6",
      "timeoutMs": 1800000
    }
  },
  "tiers": {
    "light": ["claude-haiku"],
    "standard": ["codex-standard", "claude-haiku"],
    "deep": ["claude-opus", "codex-flagship"]
  },
  "defaultTier": "standard",
  "stages": {
    "queue": { "action": "refine", "tier": "light" },
    "refined": { "action": "implement", "tier": "standard" }
  },
  "sources": {
    "github": {
      "enabled": false,
      "repos": [],
      "polling": {
        "maxIssuesPerRepo": 25,
        "commentPageSize": 25,
        "lookbackMs": 60000
      },
      "policy": {
        "requiredLabels": [],
        "ignoredLabels": [],
        "requiredAssignees": []
      },
      "publication": {
        "postStatusComments": true
      }
    }
  }
}
```

## Configuration Sections

### paths

Runtime and storage directories.

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `wakeRoot` | string | Root directory where Wake stores state, fixtures, and persistent data | `.wake` |
| `promptsRoot` | string (optional) | Explicit prompt-template root; defaults to `<wakeRoot>/prompts` | `<wakeRoot>/prompts` |

### sandbox

Docker sandbox settings for the durable Wake container.

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `image` | string | Docker image Wake uses for the sandbox | `"wake-sandbox"` |
| `containerName` | string | Container name Wake starts and reuses | `"wake-sandbox"` |
| `containerMountPath` | string | Container path where the Wake home is bind-mounted | `"/wake"` |
| `containerHomeMountPath` | string | Container path where the sandbox home directory is bind-mounted | `"/home/wake"` |
| `extraMounts` | `{ source: string, target: string, readOnly?: boolean }[]` | Additional host paths to mount into the sandbox, for example Claude or Codex config from the host home directory | `[]` |

To expose host Claude auth inside the sandbox, mount individual files rather
than the whole `~/.claude` directory:

```json
{
  "schemaVersion": 1,
  "sandbox": {
    "extraMounts": [
      {
        "source": "C:/Users/alice/.claude/.credentials.json",
        "target": "/home/wake/.claude/.credentials.json",
        "readOnly": true
      },
      {
        "source": "C:/Users/alice/.claude/settings.json",
        "target": "/home/wake/.claude/settings.json",
        "readOnly": true
      }
    ]
  }
}
```

`.credentials.json` carries login tokens and `settings.json` carries plugin
enablement flags (e.g. `enabledPlugins`) — both are plain data with no
filesystem paths baked in, so they're portable between the host OS and the
sandbox's Linux container.

**Do not mount the whole `~/.claude` directory.** Plugin bookkeeping files
under `~/.claude/plugins/` (`installed_plugins.json`,
`known_marketplaces.json`, `plugin-catalog-cache.json`) record *absolute
install paths* written by whichever OS's Claude process touched them last —
e.g. `C:\Users\alice\.claude\plugins\cache\...` on Windows. If the entire
directory is bind-mounted into the Linux container, the container's Claude
CLI reads those same Windows paths and can't resolve them, so it reports the
plugin/marketplace as failed to load (`cache-miss`) even though a plugin
cache exists on disk. Because the mount is bidirectional, this also risks the
sandbox's Claude process overwriting the host's plugin bookkeeping with
paths that don't make sense back on the host.

Instead, let the sandbox maintain its own `~/.claude/plugins` under the
container home mount (`containerHomeMountPath`, e.g.
`container-home/.claude/plugins` on the host) and install/enable plugins
there independently (`claude plugin marketplace add ...`,
`claude plugin install ...`). Only the two files above need to come from the
host.

`settings.json` must stay writable (`readOnly: false`). `claude plugin
install`/`enable`/`disable` all write their enablement state back into
`settings.json` — if it's mounted read-only, those commands fail outright
(`Failed to update settings: ... EBUSY`), which also means the
`enabledPlugins` entries the host declared can never be turned into an
actual local install inside the sandbox.

`.credentials.json` can safely be marked `readOnly: true` (as above) if you
want the sandbox to use the host's login without ever mutating it. The
tradeoff is that if Claude needs to refresh an OAuth token from inside the
sandbox, it can't persist the refreshed token back to `.credentials.json`, so
a long-running sandbox may eventually need re-authentication even though the
host session stays valid. Set it to `false` instead if you want the sandbox
to be able to log in or refresh credentials on the host's behalf.

Do not mount host `~/.config/gh` into the sandbox by default. That would let
Wake reuse the host GitHub identity directly, which widens the blast radius if
the sandbox does the wrong thing. Prefer authenticating GitHub separately
inside the sandbox when Wake needs GitHub access there.

If you have a narrower setup and only want to expose plain un-packaged skills,
you can mount `~/.claude/skills` directly to `/home/wake/.claude/skills`
instead. If you do that, do not expect Claude settings, plugin enablement, or
credentials from the host to come along with it.

For Codex, the narrow equivalent is to mount only the user config and auth
files rather than the whole `~/.codex` tree:

```json
{
  "schemaVersion": 1,
  "sandbox": {
    "extraMounts": [
      {
        "source": "C:/Users/alice/.codex/config.toml",
        "target": "/home/wake/.codex/config.toml"
      },
      {
        "source": "C:/Users/alice/.codex/auth.json",
        "target": "/home/wake/.codex/auth.json",
        "readOnly": true
      }
    ]
  }
}
```

`config.toml` is the user-level Codex configuration file and `auth.json`
stores Codex account tokens. In Wake's Docker flow, prefer mounting just these
portable files, plus any optional plain-skill directories you explicitly want,
instead of bind-mounting the whole `~/.codex` directory across host/container
boundaries.

For Cursor, mount the user-level auth directory:

```json
{
  "schemaVersion": 1,
  "sandbox": {
    "extraMounts": [
      {
        "source": "C:/Users/alice/.cursor",
        "target": "/home/wake/.cursor"
      }
    ]
  }
}
```

The `~/.cursor` directory stores Cursor's session tokens and configuration.
Mount the whole directory rather than individual files since Cursor may write
multiple credential files. If you prefer read-only, set `"readOnly": true` and
re-authenticate inside the sandbox when the session expires by running
`cursor auth login` via `wake sandbox exec`.

### scheduler

Control plane tick frequency and timing.

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `intervalMs` | number | Milliseconds between control-plane ticks (minimum 1) | `60000` (60 seconds) |

### runners

Named runner registry. The object key is the routing target; `kind` selects the
adapter implementation. Multiple entries can share the same `kind` with
different models, commands, or timeouts.

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `"fake"` \| `"claude"` \| `"codex"` \| `"cursor"` | Adapter kind to use for this named runner |
| `command` | string | CLI command for real runner kinds |
| `model` | string | Default model for this named runner |
| `timeoutMs` | number | Wall-clock timeout for this named runner |
| `effort` | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` (optional) | **Claude only.** Thinking effort level passed as `--effort` to the CLI. Controls extended reasoning depth. |
| `reasoningEffort` | `"low"` \| `"medium"` \| `"high"` (optional) | **Codex only.** Reasoning effort passed as `-c model_reasoning_effort=<level>`. Controls how much compute the model spends on planning before responding. |

The **Cursor runner** uses `cursor agent -p --output-format json` for
non-interactive runs. Refine-stage runs pass `--mode ask` (read-only) and
implement-stage runs pass `--force` (auto-approve writes). Session resume uses
`--resume=<session_id>`. Credentials bind-mount from `~/.cursor` — see
`docs/runner-comparison.md` for the recommended extraMounts configuration.

### tiers

Capability tiers map a closed category name to an ordered list of named runner
candidates. Current selection is deterministic: Wake uses the first configured
candidate in the tier.

### defaultTier

Fallback tier used when a stage does not set `tier` or `runner`.

### stages

Per-stage routing. A stage normally routes to a `tier`; `runner` pins a concrete
named runner and takes precedence over `tier`.

### sources.github

GitHub Issues integration and polling configuration.

#### Core Settings

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `enabled` | boolean | Enable GitHub Issues polling | `false` |
| `repos` | string[] | List of repositories to monitor (format: `"owner/repo"`) | `[]` |

#### polling

GitHub API polling behavior.

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `maxIssuesPerRepo` | number | Maximum issues to fetch per repository per poll (minimum 1) | `25` |
| `commentPageSize` | number | Page size for fetching issue comments (minimum 1) | `25` |
| `lookbackMs` | number | Only fetch issues and comments modified in the last N milliseconds (0 = all) | `60000` (1 minute) |

#### policy

Filtering rules for which issues to process.

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `requiredLabels` | string[] | Only process issues with all of these labels (empty = no requirement) | `[]` |
| `ignoredLabels` | string[] | Ignore issues with any of these labels | `[]` |
| `requiredAssignees` | string[] | Only process issues assigned to at least one of these GitHub logins (empty = no requirement) | `[]` |

#### publication

How Wake publishes work status back to GitHub.

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `postStatusComments` | boolean | Post stage updates and run completion as issue comments | `true` |
| `activeLabel` | string (optional) | Label to add when work is assigned to a stage; removed when completed | (not set) |

Wake also owns one derived status label while it works a ticket:
- `wake:status.pending`
- `wake:status.working`
- `wake:status.failed`
- `wake:status.completed`

Wake replaces only the `wake:status.*` label family and preserves unrelated issue labels.

## Loading and Merging

Wake loads configuration from `.wake/configuration.json` relative to the current working directory. If the file does not exist, Wake uses built-in defaults. Configuration is merged with defaults, so you only need to specify the properties you want to override.

For sandbox debugging, `wake sandbox logs` tails Docker container logs for the durable sandbox. Wake keeps structured run/event records durably, but raw sandbox stdout/stderr is treated as container log output rather than a Wake-managed on-disk archive.

For day-to-day local upgrades, use `wake sandbox build` followed by
`wake sandbox update`. That rebuilds the image and replaces the container while
preserving the mounted Wake home and sandbox home directories.

For example, to enable GitHub polling while keeping all other defaults:

```json
{
  "schemaVersion": 1,
  "sources": {
    "github": {
      "enabled": true,
      "repos": ["owner/repo"]
    }
  }
}
```
