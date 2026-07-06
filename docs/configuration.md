# Configuration

Wake's behavior is configured through a `configuration.json` file located at `.wake/configuration.json`. This document describes the configuration structure, properties, and defaults.

## Overview

The configuration file defines:
- Where Wake stores runtime data and state
- How the Docker sandbox is mounted and debugged
- How frequently the control plane checks for new work
- Which execution mode and Claude CLI settings to use
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
  "runner": {
    "mode": "fake",
    "claude": {
      "command": "claude",
      "model": "haiku",
      "smokeModel": "haiku",
      "sessionName": "Eddy",
      "remoteControlName": "Eddy",
      "smokePrompt": "This is Eddy, reply with \"hi Eddy only\"",
      "remoteControl": {
        "enabled": false
      }
    }
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
        "ignoredLabels": []
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
| `extraMounts` | `{ source: string, target: string, readOnly?: boolean }[]` | Additional host paths to mount into the sandbox, for example Claude config from the host home directory | `[]` |

To expose host Claude configuration inside the sandbox:

```json
{
  "schemaVersion": 1,
  "sandbox": {
    "extraMounts": [
      {
        "source": "C:/Users/alice/.claude",
        "target": "/home/wake/.claude"
      }
    ]
  }
}
```

This is the recommended shape when Wake runs the real Claude CLI in the
sandbox. Claude's user settings, plugin registry, installed plugin cache, and
file-based credentials all live under `~/.claude` on the host.

For example, on this machine:
- `~/.claude/settings.json` enables `superpowers@claude-plugins-official`
- `~/.claude/plugins/installed_plugins.json` points that plugin at
  `C:/Users/live/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1`
- `~/.claude/plugins/known_marketplaces.json` tracks the marketplace checkout
- Claude credentials are also stored under `~/.claude`

Mounting the whole `~/.claude` directory is more robust than mounting only a
plugin subtree because it keeps:
- `settings.json`
- `plugins/installed_plugins.json`
- the plugin cache under `plugins/cache/`
- Claude credentials

in the same place Claude expects to find them.

Do not mark the `~/.claude` mount read-only if you expect Claude to log in,
refresh credentials, install/update plugins, or write local state from inside
the sandbox.

Do not mount host `~/.config/gh` into the sandbox by default. That would let
Wake reuse the host GitHub identity directly, which widens the blast radius if
the sandbox does the wrong thing. Prefer authenticating GitHub separately
inside the sandbox when Wake needs GitHub access there.

If you have a narrower setup and only want to expose plain un-packaged skills,
you can mount `~/.claude/skills` directly to `/home/wake/.claude/skills`
instead. If you do that, do not expect Claude settings, plugin enablement, or
credentials from the host to come along with it.

### scheduler

Control plane tick frequency and timing.

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `intervalMs` | number | Milliseconds between control-plane ticks (minimum 1) | `60000` (60 seconds) |

### runner

Execution mode and CLI settings for agent invocation.

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `mode` | `"fake"` \| `"claude"` | Execution mode: `"fake"` for testing/fixtures, `"claude"` for real Claude CLI execution | `"fake"` |

#### runner.claude

Claude CLI settings for agent execution (used when `runner.mode` is `"claude"`).

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `command` | string | Path or command to invoke the Claude CLI | `"claude"` |
| `model` | string | Claude model ID for standard agent execution | `"haiku"` |
| `smokeModel` | string | Claude model ID for smoke tests and validation | `"haiku"` |
| `sessionName` | string | Name of the agent identity for issue context | `"Eddy"` |
| `remoteControlName` | string | Display name for remote control sessions | `"Eddy"` |
| `smokePrompt` | string | Minimal prompt used to verify Claude CLI is working | `"This is Eddy, reply with \"hi Eddy only\""` |
| `remoteControl.enabled` | boolean | Enable human remote control of agent sessions | `false` |

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
