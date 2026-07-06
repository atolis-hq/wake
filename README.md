# Wake

Wake is an autonomous agent control plane for software development.

The core idea is to coordinate local agent execution through a control plane that can:

- take work from external channels such as issue trackers
- decide the next lifecycle step for that work
- choose the appropriate CLI, model, and execution mode using deterministic rules
- run deterministic control-plane tasks without spending tokens when possible
- launch or resume local agent sessions when agentic execution is needed
- let a human jump directly into a local session when asynchronous coordination is not enough

Wake is intended to start simple. The first justified version is a small loop that can pick work, decide what to do next, execute it locally, persist state, and resume later. More advanced routing, lifecycle control, and self-improvement should only be added once that simple version proves useful.

## Concepts

- `Wake` is the control plane and decision-maker.
- `Eddy` is the thin local execution identity or wrapper that Wake launches and manages.

## Direction

Wake is intended to integrate with existing local agent CLIs such as Claude Code and Codex rather than replace them. It should run work locally, likely in a reusable isolated development environment, and use external workflow systems as the default coordination surface.

## Development

```bash
npm install
npm test
npm run tick
```

Useful commands:

- `npm run tick` runs one control-plane tick using fake ticketing-system data from `.wake/fixtures/issues.json` when present
- `npm run start` runs the resident loop
- `npm run smoke:claude` runs a minimal Claude Haiku smoke test
- `npm run smoke:claude -- --remote-control` starts a minimal remote-control Claude smoke session

## Configuration

Wake is configured via a JSON file. The configuration file path is specified using the `--config` flag when running Wake. If no config file is provided, Wake uses built-in defaults for all settings.

Configuration is loaded as JSON and merged with built-in defaults, allowing you to override only the settings you need to customize.

### Config File Format

The configuration file must be valid JSON matching the schema described below. All fields are optional; unspecified fields use built-in defaults.

### Configuration Reference

#### `paths`

- **`wakeRoot`** (string, default: `.wake`)
  - Directory where Wake stores its state, event logs, and fixtures.
  - Example: `/var/lib/wake` or `~/.config/wake`

#### `scheduler`

- **`intervalMs`** (integer, default: `1800000`)
  - Control loop interval in milliseconds. How often Wake checks for work and processes events.
  - Default of 1,800,000ms = 30 minutes
  - Example: `300000` for 5-minute intervals

#### `runner`

Runner configuration controls how Wake executes work.

- **`mode`** (string: `"fake"` | `"claude"`, default: `"fake"`)
  - Execution mode.
  - `fake`: Runs dummy execution (useful for testing)
  - `claude`: Runs real Claude Code sessions

- **`claude`** (object, required if `runner.mode` is `"claude"`)
  - Configuration for Claude-based execution
  - **`command`** (string, default: `"claude"`)
    - The command to launch Claude Code sessions (e.g., `claude` or `/usr/local/bin/claude`)
  - **`model`** (string, default: `"haiku"`)
    - The default Claude model for Eddy sessions (e.g., `haiku`, `opus`)
  - **`smokeModel`** (string, default: `"haiku"`)
    - The Claude model to use for smoke tests
  - **`sessionName`** (string, default: `"Eddy"`)
    - Session name for Claude Code
  - **`remoteControlName`** (string, default: `"Eddy"`)
    - Name for remote-control sessions
  - **`smokePrompt`** (string, default: `"This is Eddy, reply with \"hi Eddy only\""`)
    - Prompt used in smoke tests
  - **`remoteControl.enabled`** (boolean, default: `false`)
    - Enable remote-control features in Claude sessions

#### `sources`

Source configuration determines which external systems Wake monitors for work.

- **`github`** (object)
  - GitHub Issues polling configuration
  - **`enabled`** (boolean, default: `false`)
    - Enable GitHub Issues polling
  - **`repos`** (array of strings, default: `[]`)
    - List of GitHub repositories to poll (format: `"owner/repo"`)
    - Example: `["atolis-hq/wake", "anthropics/claude-code"]`
  - **`polling`** (object)
    - GitHub API polling parameters
    - **`maxIssuesPerRepo`** (integer, default: `25`)
      - Maximum number of issues to fetch per repository per poll
    - **`commentPageSize`** (integer, default: `25`)
      - Number of comments to fetch per page when loading issue threads
    - **`lookbackMs`** (integer, default: `60000`)
      - How far back to look when polling for updates (in milliseconds)
  - **`policy`** (object)
    - Issue filtering policy
    - **`requiredLabels`** (array of strings, default: `[]`)
      - If non-empty, only issues with at least one of these labels are processed
    - **`ignoredLabels`** (array of strings, default: `[]`)
      - Issues with any of these labels are ignored
  - **`publication`** (object)
    - Configuration for how Wake publishes results back to GitHub
    - **`postStatusComments`** (boolean, default: `true`)
      - Post status updates as comments on GitHub issues
    - **`activeLabel`** (string, optional)
      - Label to add to issues when Wake starts work on them

### Example Configurations

#### Minimal Configuration (Defaults)

To use all defaults, you can omit the config file or provide an empty object:

```json
{}
```

This will use:
- `.wake` as the state directory
- 30-minute control loop interval
- Fake (dummy) runner mode

#### GitHub Polling Enabled

```json
{
  "sources": {
    "github": {
      "enabled": true,
      "repos": ["my-org/my-repo"],
      "polling": {
        "maxIssuesPerRepo": 50,
        "commentPageSize": 25,
        "lookbackMs": 60000
      },
      "policy": {
        "requiredLabels": ["wake"],
        "ignoredLabels": ["no-wake"]
      },
      "publication": {
        "postStatusComments": true,
        "activeLabel": "in-progress"
      }
    }
  }
}
```

#### Claude Runner with Custom Settings

```json
{
  "scheduler": {
    "intervalMs": 300000
  },
  "runner": {
    "mode": "claude",
    "claude": {
      "command": "claude",
      "model": "opus",
      "smokeModel": "haiku",
      "sessionName": "MyEddy",
      "remoteControlName": "MyEddy",
      "smokePrompt": "Custom smoke test prompt here",
      "remoteControl": {
        "enabled": true
      }
    }
  },
  "sources": {
    "github": {
      "enabled": true,
      "repos": ["my-org/repo1", "my-org/repo2"]
    }
  }
}
```

### Loading Configuration

Wake loads configuration in the following order:

1. If a config file is specified via `--config`, load and parse it as JSON
2. Merge the provided config with built-in defaults
3. Validate the merged configuration against the schema

Example:

```bash
wake --config ./wake-config.json
```

If no `--config` flag is provided, Wake uses built-in defaults for all settings.

## GitHub Issues Polling

Wake can poll configured GitHub repositories when `sources.github.enabled` is
set to `true`. Authentication is resolved from the current GitHub CLI session
via `gh auth token`, and Wake uses a fixed runner mode of either `fake` or
`claude`.

GitHub Issues sync runs inside the normal tick path. Each tick polls GitHub,
translates provider payloads into canonical ticket events, appends those
events, rebuilds local projections, decides whether work is needed, and only
then invokes Eddy.

The default Claude smoke prompt is intentionally tiny:

```text
This is Eddy, reply with "hi Eddy only"
```
