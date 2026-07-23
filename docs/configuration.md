# Configuration

Wake's behavior is configured through a `config.json` file at the root of a
Wake home directory (see [docs/getting-started.md](getting-started.md)).
This document describes the configuration structure, properties, and
defaults.

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
    "wakeRoot": "/path/to/wake-home",
    "promptsRoot": "/path/to/wake-home/prompts"
  },
  "sandbox": {
    "image": "wake-sandbox",
    "imageRepository": "wake-sandbox",
    "containerName": "wake-sandbox-my-project",
    "containerMountPath": "/wake",
    "containerHomeMountPath": "/home/wake",
    "start": { "enabled": true },
    "extraMounts": []
  },
  "scheduler": {
    "intervalMs": 60000,
    "maxIntervalMs": 300000
  },
  "transcripts": {
    "enabled": false,
    "retainAfterWorkspaceCleanup": false
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
    "cursor-composer": {
      "kind": "cursor",
      "command": "cursor",
      "model": "composer-2.5",
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
    "implement": { "action": "implement", "tier": "standard" }
  },
  "ui": {
    "enabled": false,
    "port": 4317,
    "tunnel": {
      "enabled": false
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
        "ignoredLabels": [],
        "requiredAssignees": []
      },
      "publication": {
        "postStatusComments": true
      },
      "pullRequests": {
        "enabled": false,
        "maxPullRequestsPerRepo": 25,
        "commentPageSize": 25,
        "policy": {
          "requiredAuthors": []
        }
      }
    }
  }
}
```

## Configuration Sections

### paths

Runtime and storage directories.

| Property      | Type              | Description                                                                                                    | Default              |
| ------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------- |
| `wakeRoot`    | string            | The Wake home directory itself. Always resolved fresh from `--wake-root`/the current directory — not user-set. | current directory    |
| `promptsRoot` | string (optional) | Explicit prompt-template root; defaults to `<wakeRoot>/prompts`                                                 | `<wakeRoot>/prompts` |

Internal/durable data (`events/`, `state/`, `runs/`, `sources/`, `repos/`,
`locks/`, `logs/`, `container-home/`, `ledger.json`) lives under a hidden
`<wakeRoot>/.wake/` — see [docs/getting-started.md](getting-started.md) for
the full directory layout.

Prompt templates are Handlebars markdown files named `prompts/<action>.md`, for
example `prompts/refine.md`. Wake passes `mode`, `isStart`, and `isResume` into
the template so start/resume wording can branch inside one file. Legacy
`<action>.start.md` and `<action>.resume.md` files are still read when no
combined `<action>.md` file exists.

Workflow stages reference these prompt templates through their `action` field.
For a workflow-focused guide, including how workflows are selected and how stage
transitions work, see [docs/workflows.md](workflows.md).

### commands

Custom slash commands map issue or correlated-PR comments to runner actions.
The object key is the command name without the leading slash. Wake matches a
configured command only when it appears as a token at the start of a trimmed
comment line, so inline mentions like `please run /codereview` are ignored.

```json
"commands": {
  "ask": {
    "action": "ask",
    "workspace": "read-only",
    "tier": "light"
  },
  "codereview": {
    "action": "codereview",
    "workspace": "read-only",
    "tier": "standard"
  }
}
```

| Property    | Type                                    | Description                                                                           | Default       |
| ----------- | --------------------------------------- | ------------------------------------------------------------------------------------- | ------------- |
| `action`    | string (optional)                       | Prompt action to run; defaults to the command name and expects `prompts/<command>.md` | command name  |
| `workspace` | `"none"` \| `"read-only"` \| `"branch"` | Workspace kind prepared for the command run                                           | `"read-only"` |
| `tier`      | string (optional)                       | Runner tier for this command; falls back to `defaultTier` when omitted                | unset         |
| `runner`    | string (optional)                       | Concrete runner to use for this command; takes precedence over `tier`                 | unset         |

`/ask` and `/codereview` are built-in custom commands. `/approved` and
`/changes` are reserved for Wake's approval control flow and cannot be
redefined as custom commands. Completed custom commands do not advance the work
item's workflow stage; they handle the command comment and leave the current
lifecycle state in place.

### sandbox

Docker sandbox settings for the durable Wake container.

| Property                 | Type                                                       | Description                                                                                                                                                                                                | Default          |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `image`                  | string                                                     | Docker image (including tag) Wake uses for the sandbox                                                                                                                                                     | `"wake-sandbox"` |
| `imageRepository`        | string                                                     | Base image name (no tag) that `wake sandbox self-update` appends a release tag to, e.g. `wake-sandbox:v0.0.80`; old tags are kept so a failed update can roll back to the previous image without a rebuild | `"wake-sandbox"` |
| `containerName`          | string                                                     | Container name Wake starts and reuses; derived from the wake-root directory name at `init` time (e.g., `wake-sandbox-<dirname>`) rather than a fixed literal | `wake-sandbox-<dirname>` |
| `containerMountPath`     | string                                                     | Container path where the Wake home is bind-mounted                                                                                                                                                         | `"/wake"`        |
| `containerHomeMountPath` | string                                                     | Container path where the sandbox home directory is bind-mounted                                                                                                                                            | `"/home/wake"`   |
| `start.enabled`          | boolean                                                    | Whether the sandbox entrypoint starts the resident `wake start` loop automatically                                                                                                                         | `true`           |
| `extraMounts`            | `{ source: string, target: string, readOnly?: boolean }[]` | Additional host paths to mount into the sandbox, for example Claude or Codex config from the host home directory                                                                                           | `[]`             |

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
`known_marketplaces.json`, `plugin-catalog-cache.json`) record _absolute
install paths_ written by whichever OS's Claude process touched them last —
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

For Cursor, mount the auth file that `agent login` writes:

```json
{
  "schemaVersion": 1,
  "sandbox": {
    "extraMounts": [
      {
        "source": "C:/Users/alice/.config/cursor/auth.json",
        "target": "/home/wake/.config/cursor/auth.json",
        "readOnly": true
      }
    ]
  }
}
```

`~/.config/cursor/auth.json` is the file written by `agent login` and is the
only Cursor file that needs to be shared with the sandbox. Mount it read-only
unless you want the sandbox to be able to refresh tokens on the host's behalf.
Re-authenticate inside the sandbox when the session expires by running
`agent login` via `wake sandbox exec`.

### transcripts

Raw runner prompt and response capture for debugging.

When enabled, Wake writes text files under
`<wakeRoot>/.wake/transcripts/<workId>/<session-or-run>/`, where `<workId>` is
the work item's minted `work-<ulid>` identity (the same key used by
`.wake/state/<workId>.json`). Each runner run
writes a separate `*.prompt.txt` file with the exact prompt text passed to the
CLI prompt argument and a matching `*.response.txt` file with raw stdout from
the CLI. Initial runs are grouped by Wake `runId`; resumed runs are grouped by
the previously recorded agent session ID when Wake has one.

| Property                      | Type    | Description                                                                          | Default |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------ | ------- |
| `enabled`                     | boolean | Write raw runner prompt and response text files                                      | `false` |
| `retainAfterWorkspaceCleanup` | boolean | Keep transcript directories when Wake cleans up a closed issue's per-issue workspace | `false` |

### scheduler

Control plane tick frequency and timing.

| Property        | Type   | Description                                                                                                                                                                               | Default              |
| --------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `intervalMs`    | number | Milliseconds between control-plane ticks (minimum 1)                                                                                                                                      | `60000` (60 seconds) |
| `maxIntervalMs` | number | Ceiling for the idle-cadence backoff: each consecutive idle tick doubles the sleep (starting from `intervalMs`) up to this value, and any `processed` tick resets it back to `intervalMs` | `300000` (5 minutes) |

### runners

Named runner registry. The object key is the routing target; `kind` selects the
adapter implementation. Multiple entries can share the same `kind` with
different models, commands, or timeouts.

| Property          | Type                                                                 | Description                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`            | `"fake"` \| `"claude"` \| `"codex"` \| `"cursor"`                    | Adapter kind to use for this named runner                                                                                                                 |
| `command`         | string                                                               | CLI command for real runner kinds                                                                                                                         |
| `model`           | string                                                               | Default model for this named runner                                                                                                                       |
| `timeoutMs`       | number                                                               | Wall-clock timeout for this named runner                                                                                                                  |
| `effort`          | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` (optional) | **Claude only.** Thinking effort level passed as `--effort` to the CLI. Controls extended reasoning depth.                                                |
| `reasoningEffort` | `"low"` \| `"medium"` \| `"high"` (optional)                         | **Codex only.** Reasoning effort passed as `-c model_reasoning_effort=<level>`. Controls how much compute the model spends on planning before responding. |

The **Cursor runner** uses `cursor agent -p --output-format json` for
non-interactive runs. Refine-stage runs pass `--mode ask` (read-only) and
implement-stage runs pass `--force` (auto-approve writes). Session resume uses
`--resume=<session_id>`. Credentials bind-mount from `~/.cursor` — see
`docs/runner-comparison.md` for the recommended extraMounts configuration.

### tiers

Capability tiers map a closed category name to an ordered list of named runner
candidates. Wake normally uses the first configured candidate in the tier, but
falls sideways to the next candidate whenever a higher-priority one is
currently quota-paused (tracked per-runner in `ledger.json`, see below), and
rotates back to the primary candidate automatically once its pause expires. If
every candidate in a tier is paused, Wake leaves that item alone for the tick
(no run is claimed) rather than running against a runner it already knows is
exhausted.

A quota pause is either **reported** (the CLI told us the real reset time,
e.g. Claude's "resets 1:10am (UTC)") or **estimated** (no reset time was
found, so Wake backs off exponentially: 15min, 30min, 1h, capped at 1h).
Reported pauses are trusted for their full duration. Estimated pauses get an
early recovery probe: 15 minutes after the failure that triggered the pause,
Wake lets one real attempt through even though the estimated pause hasn't
fully elapsed, in case the guess overshot and quota actually reset sooner. A
failed probe simply recomputes the backoff from the new failure, same as any
other quota failure.

### defaultTier

Fallback tier used when a stage does not set `tier` or `runner`.

### stages

Per-stage routing. A stage normally routes to a `tier`; `runner` pins a concrete
named runner and takes precedence over `tier`.

### ui

Optional settings for the read-only control-plane UI (`wake ui` / `npm run
ui`). All fields are optional and default to a loopback-only, tokenless
server:

```json
"ui": {
  "enabled": false,
  "port": 4317,
  "token": null,
  "tunnel": {
    "enabled": false,
    "authToken": null
  }
}
```

- `enabled` — when `true`, `wake sandbox up`/`wake sandbox update` publish
  `ui.port` from the container to `127.0.0.1:<ui.port>` on the host and pass
  `WAKE_UI_ENABLED`/`WAKE_UI_PORT`/`WAKE_UI_TOKEN` into the container; the
  container's `wake sandbox-entrypoint` process then starts `wake ui --host
  0.0.0.0` automatically alongside the resident loop. `false` (the default) leaves the
  container exactly as before — no published port, no auto-started process.
- `port` — port `wake ui` binds (`--port` overrides this), and the port
  published from the container when `enabled` is true. Default `4317`.
- `token` — optional shared-secret bearer token (also settable via `--token` or
  the `WAKE_UI_TOKEN` env var). When set, every UI request must include
  `Authorization: Bearer <token>` or a `wake_ui_token` cookie.
- `tunnel.enabled` — when `true` and `ui.enabled` is also true, the sandbox
  entrypoint starts `ngrok http 127.0.0.1:<ui.port>` inside the container and
  writes the discovered public URL to `<wakeRoot>/.wake/control-plane-ui-url`. GitHub
  status comments then link the `Wake` header to that URL. Default `false`.
- `tunnel.authToken` — optional ngrok authtoken passed to the container as
  `NGROK_AUTHTOKEN`. To avoid storing the token in `config.json`, leave this
  unset and export `NGROK_AUTHTOKEN` before `wake sandbox up` or
  `wake sandbox update`; the Docker run command passes it through when the
  tunnel is enabled. Ngrok provides free HTTPS tunnels, but it generally
  requires a free account authtoken.

See [docs/specs/control-plane-ui.md](specs/control-plane-ui.md) for the full
design; the current implementation covers the v0 read-only surface (status
bar, condition board, item detail, activity feed, config view, health view)
with no mutation endpoints yet.

### wake correlate

```
wake correlate <workItemKey> <resourceUri> [--role <role>] [--wake-root <path>]
```

Operator escape hatch for the correlation registry (see
[docs/superpowers/specs/2026-07-16-work-identity-correlation-design.md](superpowers/specs/2026-07-16-work-identity-correlation-design.md)
§5–§6). Use it to declare by hand that a resource (a GitHub PR, a Slack
thread, etc.) belongs to an existing work item when nothing detected the
correlation automatically.

- `<workItemKey>` must be an existing work item's key (`work-<ulid>`); an
  unknown key is rejected rather than minting a phantom work item.
- `<resourceUri>` must match the `<provider>:<kind>:<locator>` grammar (see
  `src/domain/resource-uri.ts`); a malformed URI is rejected.
- `--role` sets the correlation role and defaults to `implementation`. Must be
  one of the closed vocabulary: `representation`, `implementation`,
  `discussion`, `review`, `documentation`, `decision`.
- The declaration is always requested as `primary`, `provenance:
operator-declared`. If another work item already holds the URI as
  `primary`, the fold downgrades this registration to `secondary` and emits a
  `wake.correlation.primary-conflict` event rather than stealing the URI.

Like every other correlation-affecting change, this command appends an event
and lets the projection fold decide the outcome — it never writes the
resource index or a work item's projection directly, so `rm -rf state/` plus
replay still reproduces the same result.

### sources.github

GitHub Issues integration and polling configuration.

#### Core Settings

| Property  | Type     | Description                                              | Default |
| --------- | -------- | -------------------------------------------------------- | ------- |
| `enabled` | boolean  | Enable GitHub Issues polling                             | `false` |
| `repos`   | string[] | List of repositories to monitor (format: `"owner/repo"`) | `[]`    |

#### polling

GitHub API polling behavior.

| Property           | Type   | Description                                                                  | Default            |
| ------------------ | ------ | ---------------------------------------------------------------------------- | ------------------ |
| `maxIssuesPerRepo` | number | Maximum issues to fetch per repository per poll (minimum 1)                  | `25`               |
| `commentPageSize`  | number | Page size for fetching issue comments (minimum 1)                            | `25`               |
| `lookbackMs`       | number | Only fetch issues and comments modified in the last N milliseconds (0 = all) | `60000` (1 minute) |

#### policy

Filtering rules for which issues to process.

| Property            | Type     | Description                                                                                  | Default |
| ------------------- | -------- | -------------------------------------------------------------------------------------------- | ------- |
| `requiredLabels`    | string[] | Only process issues with all of these labels (empty = no requirement)                        | `[]`    |
| `ignoredLabels`     | string[] | Ignore issues with any of these labels                                                       | `[]`    |
| `requiredAssignees` | string[] | Only process issues assigned to at least one of these GitHub logins (empty = no requirement) | `[]`    |

#### publication

How Wake publishes work status back to GitHub.

| Property             | Type              | Description                                                           | Default   |
| -------------------- | ----------------- | --------------------------------------------------------------------- | --------- |
| `postStatusComments` | boolean           | Post stage updates and run completion as issue comments               | `true`    |
| `activeLabel`        | string (optional) | Label to add when work is assigned to a stage; removed when completed | (not set) |

Wake also owns one derived status label while it works a ticket:

- `wake:status.pending`
- `wake:status.working`
- `wake:status.failed`
- `wake:status.completed`

Wake replaces only the `wake:status.*` label family and preserves unrelated issue labels.

#### pullRequests

GitHub Pull Requests activity monitoring and correlation.

When enabled, Wake monitors pull requests for activity (comments, reviews) on PRs
already correlated to work items, and optionally discovers new uncorrelated PRs
for standalone work adoption if they match the qualification policy.

| Property                 | Type     | Description                                                                                                  | Default |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------ | ------- |
| `enabled`                | boolean  | Enable PR activity polling and optional PR discovery                                                         | `false` |
| `maxPullRequestsPerRepo` | number   | Maximum PRs to fetch per repository per poll (minimum 1)                                                     | `25`    |
| `commentPageSize`        | number   | Page size for fetching PR comments and reviews (minimum 1)                                                   | `25`    |
| `checks.enabled`         | boolean  | Poll correlated PRs for failing required check runs and legacy statuses                                      | `true`  |
| `policy.requiredAuthors` | string[] | GitHub logins allowed to author new standalone PRs; empty means no uncorrelated PR will mint a new work item | `[]`    |

**Important:** A pull request opened by Wake's own agent as an artifact from an issue
never requires author qualification — it is registered through artifact verification,
not the `requiredAuthors` gate. Author qualification applies only to PRs already in
the repository that Wake did not create.

**Reviewer feedback on Wake's own PRs:** while a work item is
`awaiting-approval`, a new comment on a correlated PR (a review, a
review-thread reply, a plain PR comment, or a newly failing required check)
is treated as reviewer feedback
and automatically triggers Wake's `revise` action — unlike comments on the
originating issue, no slash command is required. The agent judges each comment
independently: it may make the change, answer a question, or push back with
justification or an alternative. The work item stays `awaiting-approval`
afterward; only an
explicit `/approved` command (on the issue or the PR) advances it to
`done`.

## Loading and Merging

Wake loads configuration from `.wake/config.json` relative to the current working directory. If the file does not exist, Wake uses built-in defaults. Configuration is merged with defaults, so you only need to specify the properties you want to override.

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
