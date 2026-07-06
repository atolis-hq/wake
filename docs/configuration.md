# Configuration

Wake's behavior is configured through a `configuration.json` file located at `.wake/configuration.json`. This document describes the configuration structure, properties, and defaults.

## Overview

The configuration file defines:
- Where Wake stores runtime data and state
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
    "wakeRoot": ".wake"
  },
  "scheduler": {
    "intervalMs": 1800000
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

### scheduler

Control plane tick frequency and timing.

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `intervalMs` | number | Milliseconds between control-plane ticks (minimum 1) | `1800000` (30 minutes) |

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

## Loading and Merging

Wake loads configuration from `.wake/configuration.json` relative to the current working directory. If the file does not exist, Wake uses built-in defaults. Configuration is merged with defaults, so you only need to specify the properties you want to override.

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
