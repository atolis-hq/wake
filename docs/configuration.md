?# Configuration

Wake's behavior is configured through YAML files at the root of a Wake home
directory (see [docs/getting-started.md](getting-started.md)). Wake reads
**every file matching `config.yaml` or `config.<label>.yaml`** in that
directory and deep-merges them together — nested objects merge key by key,
arrays and scalars are replaced wholesale by whichever file sets them last.
Files are merged in alphabetical order by filename, so a later-sorting file
wins on any key both files set. There's no required layout: split
configuration into as many or as few files as you want.

`wake init` scaffolds a default two-file split:

- **`config.yaml`** — infra/operational settings: storage paths, Docker
  sandbox mounting, scheduler timing, transcripts, the control-plane UI, and
  which external sources (like GitHub) to monitor.
- **`config.workflows.yaml`** — behavior/policy settings: the runner
  registry, capability runnerPools, workflow and stage definitions, custom
  commands, and per-stage routing. These are kept together by default
  because they reference each other by name — a stage route names a `runnerPool`,
  a runnerPool names `runners`, a workflow selector names a `workflow` — but
  nothing stops you from splitting further, e.g. a standalone
  `config.sources.yaml` for GitHub polling settings.

Any field left unset in every file falls back to a built-in default.
`config.yaml` carries `schemaVersion: 1`.

## Full Sample Configuration

`config.yaml`:

```yaml
schemaVersion: 1
paths:
  wakeRoot: /path/to/wake-home
sandbox:
  image: wake-sandbox
  imageRepository: wake-sandbox
  containerName: wake-sandbox-my-project
  containerMountPath: /wake
  containerHomeMountPath: /home/wake
  start:
    enabled: true
  extraMounts: []
scheduler:
  intervalMs: 60000
  maxIntervalMs: 300000
execution:
  agentRunners:
    fake:
      kind: fake
    claude-haiku:
      kind: claude-cli
      command: claude
      model: claude-haiku-4-5
      timeoutMs: 600000
    claude-opus:
      kind: claude-cli
      command: claude
      model: claude-opus-4-8
      timeoutMs: 1800000
    codex-standard:
      kind: codex-cli
      command: codex
      model: gpt-5.4
      effort: medium
      timeoutMs: 1200000
    codex-flagship:
      kind: codex-cli
      command: codex
      model: gpt-5.5
      effort: high
      timeoutMs: 1800000
    cursor-composer:
      kind: cursor-cli
      command: cursor
      model: composer-2.5
      timeoutMs: 1800000
  runnerPools:
    light: [claude-haiku]
    standard: [codex-standard, claude-haiku]
    deep: [claude-opus, codex-flagship]
  defaultRunnerPool: standard
transcripts:
  enabled: false
  retentionMs: 259200000
retry:
  maxFailureRetries: 5
  maxChangesRequestedRetries: 3
ui:
  enabled: false
  port: 4317
  tunnel:
    enabled: false
sources:
  github:
    enabled: false
    repos: []
    polling:
      maxIssuesPerRepo: 25
      commentPageSize: 25
      lookbackMs: 60000
    policy:
      requiredLabels: []
      ignoredLabels: []
      requiredAssignees: []
    publication:
      postStatusComments: true
    pullRequests:
      enabled: false
      maxPullRequestsPerRepo: 25
      commentPageSize: 25
      policy:
        requiredAuthors: []
```

`config.workflows.yaml`:

```yaml
workflows:
  default:
    stages:
      refine:
        action: refine
        workspace: read-only
        runnerPool: light
        onDone: implement
      implement:
        action: implement
        workspace: branch
        runnerPool: standard
        onDone: done
```

### Splitting further

Any file named `config.yaml` or `config.<label>.yaml` in the Wake home root
is read and merged. For example, to keep GitHub polling settings separate
from the rest of `config.yaml`:

`config.sources.yaml`:

```yaml
sources:
  github:
    enabled: true
    repos: [owner/repo]
```

Wake merges this with whatever `config.yaml` also sets under `sources` —
merging is recursive, not a whole-file override, so `config.yaml` can leave
`sources` out entirely and this file is the only place it's set, or both
files can set different sub-fields of `sources.github` and both take
effect. Wake never rewrites these files — whatever split you create is the
split that persists.

## Configuration Sections

### paths

_Lives in `config.yaml`._

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

_Lives in `config.workflows.yaml`._

Custom slash commands map issue or correlated-PR comments to runner actions.
The object key is the command name without the leading slash. Wake matches a
configured command only when it appears as a token at the start of a trimmed
comment line, so inline mentions like `please run /codereview` are ignored.

```yaml
commands:
  ask:
    action: ask
    workspace: read-only
    runnerPool: light
  codereview:
    action: codereview
    workspace: read-only
    runnerPool: standard
```

| Property    | Type                                    | Description                                                                           | Default       |
| ----------- | --------------------------------------- | ------------------------------------------------------------------------------------- | ------------- |
| `action`    | string (optional)                       | Prompt action to run; defaults to the command name and expects `prompts/<command>.md` | command name  |
| `workspace` | `"none"` \| `"read-only"` \| `"branch"` | Workspace kind prepared for the command run                                           | `"read-only"` |
| `runnerPool`      | string (optional)                       | Runner runnerPool for this command; falls back to `defaultRunnerPool` when omitted                | unset         |
| `runner`    | string (optional)                       | Concrete runner to use for this command; takes precedence over `runnerPool`                 | unset         |

`/ask` and `/codereview` are built-in custom commands. `/approved`, `/changes`,
and `/interrupt` are reserved for Wake's own control flow and cannot be
redefined as custom commands. Completed custom commands do not advance the work
item's workflow stage; they handle the command comment and leave the current
lifecycle state in place.

A plain comment posted while a run is active is treated as additional context
for the next turn — it does not interrupt the in-progress run. Posting
`/interrupt` on the issue or PR thread cancels the active run immediately so
the next tick can pick up the new direction, instead of letting the run finish
against a now-superseded snapshot.

### sandbox

_Lives in `config.yaml`._

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

```yaml
schemaVersion: 1
sandbox:
  extraMounts:
    - source: C:/Users/alice/.claude/.credentials.json
      target: /home/wake/.claude/.credentials.json
      readOnly: true
    - source: C:/Users/alice/.claude/settings.json
      target: /home/wake/.claude/settings.json
      readOnly: true
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

```yaml
schemaVersion: 1
sandbox:
  extraMounts:
    - source: C:/Users/alice/.codex/config.toml
      target: /home/wake/.codex/config.toml
    - source: C:/Users/alice/.codex/auth.json
      target: /home/wake/.codex/auth.json
      readOnly: true
```

`config.toml` is the user-level Codex configuration file and `auth.json`
stores Codex account tokens. In Wake's Docker flow, prefer mounting just these
portable files, plus any optional plain-skill directories you explicitly want,
instead of bind-mounting the whole `~/.codex` directory across host/container
boundaries.

For Cursor, mount the auth file that `agent login` writes:

```yaml
schemaVersion: 1
sandbox:
  extraMounts:
    - source: C:/Users/alice/.config/cursor/auth.json
      target: /home/wake/.config/cursor/auth.json
      readOnly: true
```

`~/.config/cursor/auth.json` is the file written by `agent login` and is the
only Cursor file that needs to be shared with the sandbox. Mount it read-only
unless you want the sandbox to be able to refresh tokens on the host's behalf.
Re-authenticate inside the sandbox when the session expires by running
`agent login` via `wake sandbox exec`.

### transcripts

_Lives in `config.yaml`._

Raw runner prompt and response capture for debugging.

When enabled, Wake writes text files under
`<wakeRoot>/.wake/transcripts/<workId>/<session-or-run>/`, where `<workId>` is
the work item's minted `work-<ulid>` identity (the same key used by
`.wake/state/<workId>.json`). Each runner run
writes a separate `*.prompt.txt` file with the exact prompt text passed to the
CLI prompt argument and a matching `*.response.txt` file with raw stdout from
the CLI. Initial runs are grouped by Wake `runId`; resumed runs are grouped by
the previously recorded agent session ID when Wake has one.

| Property      | Type    | Description                                                                                                  | Default     |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------ | ----------- |
| `enabled`     | boolean | Write raw runner prompt and response text files                                                              | `false`     |
| `retentionMs` | integer | Milliseconds to retain transcripts after workspace cleanup. Set `0` to delete immediately during cleanup.    | `259200000` |

The legacy `retainAfterWorkspaceCleanup` boolean is no longer supported. Wake
fails config parsing if that key is present so existing retention settings do
not silently change behavior on upgrade.

### retry

_Lives in `config.yaml`._

Retry limits for failed runner attempts and auto-revise loops.

| Property                     | Type   | Description                                                                                                     | Default |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `maxFailureRetries`          | number | Maximum consecutive failed runner attempts before automatic retries go idle                                       | `5`     |
| `maxChangesRequestedRetries` | number | Maximum consecutive `changes-requested` auto-revise cycles (a rejecting `plan-review`/`pr-review` watcher, or a human `/changes` reply) before Wake escalates to `blocked` instead of re-running automatically | `3`     |

### scheduler

_Lives in `config.yaml`._

Control plane tick frequency and timing.

| Property        | Type   | Description                                                                                                                                                                               | Default              |
| --------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `intervalMs`    | number | Milliseconds between control-plane ticks (minimum 1)                                                                                                                                      | `60000` (60 seconds) |
| `maxIntervalMs` | number | Ceiling for the idle-cadence backoff: each consecutive idle tick doubles the sleep (starting from `intervalMs`) up to this value, and any `processed` tick resets it back to `intervalMs` | `300000` (5 minutes) |

#### dispatchRateLimit

A deterministic circuit breaker on total runner invocations (both the main
dispatch path and stage watchers), independent of any specific
dispatch-eligibility bug. Counted from durable run records in a trailing
window, not an in-memory counter, so it holds across process restarts. Once
the window's run count reaches `maxDispatches`, the tick idles instead of
dispatching, and Wake records a `dispatch.rate-limited` autonomous-decision
audit event (see `wake audit`) explaining why.

| Property        | Type   | Description                                     | Default                |
| --------------- | ------ | ------------------------------------------------ | ----------------------- |
| `windowMs`      | number | Trailing window, in milliseconds, to count runs over | `3600000` (1 hour) |
| `maxDispatches` | number | Maximum runner invocations allowed within the window | `20`                |

### execution.agentRunners

_Lives in `config.yaml`, under `execution`._

Named runner registry. The object key is the routing target; `kind` selects the
transport adapter. Multiple entries can share the same `kind` with different
models, commands, static arguments, timeouts, or effort.

| Property | Type | Description |
| --- | --- | --- |
| `kind` | `"claude-cli"` \| `"codex-cli"` \| `"cursor-cli"` \| `"command"` \| `"fake"` | Transport adapter for this named runner. All but `fake` require `command`. |
| `command` | string (required except `fake`) | CLI command for command-style runner kinds. |
| `model` | string (optional) | Default model for this named runner. |
| `effort` | string (optional) | Portable reasoning-effort selection. Codex maps it to `-c model_reasoning_effort=<effort>`; Claude, Cursor, `command`, and `fake` omit it because they have no mapping. |
| `timeoutMs` | positive integer (optional) | Wall-clock timeout; defaults to `1800000` milliseconds. |
| `args` | string array (optional) | Static CLI arguments; defaults to `[]`. Do not include `--output-format` or `--resume`, which Wake owns. |

The **Cursor runner** uses `cursor agent -p --output-format json` for
non-interactive runs. Refine-stage runs pass `--mode ask` (read-only) and
implement-stage runs pass `--force` (auto-approve writes). Session resume uses
`--resume=<session_id>`. Credentials bind-mount from `~/.cursor` — see
`docs/runner-comparison.md` for the recommended extraMounts configuration.

### execution.runnerPools

_Lives in `config.yaml`, under `execution`._

Capability runnerPools map a closed category name to an ordered list of named runner
candidates. Wake normally uses the first configured candidate in the runnerPool, but
falls sideways to the next candidate whenever a higher-priority one is
currently quota-paused (tracked per-runner in `ledger.json`, see below), and
rotates back to the primary candidate automatically once its pause expires. If
every candidate in a runnerPool is paused, Wake leaves that item alone for the tick
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

### execution.defaultRunnerPool

_Lives in `config.yaml`, under `execution`._

Fallback runnerPool used when a stage does not set `runnerPool` or `runner`.

### workflows

_Lives in `config.workflows.yaml`._

Workflow definitions contain the runnable stages and their actions. A workflow
stage normally routes to a `runnerPool`; `runner` pins a concrete named runner and
takes precedence over `runnerPool`.

Workflow stages may also define `watch` entries. `watch[].onSuccess` declares
what Wake does when the watched child workflow run completes `DONE` or
`REJECTED` — the child's sentinel is its verdict:

```yaml
workflows:
  default:
    stages:
      refine:
        action: refine
        workspace: read-only
        onDone: implement
        watch:
          - while: { status: [awaiting-approval] }
            on: { event: [wake.run.completed] }
            workflow: plan-review
            onSuccess:
              approve: true
      implement:
        action: implement
        workspace: branch
        onDone: done
        watch:
          - while: { status: [awaiting-approval] }
            on: { event: [wake.run.completed] }
            schedule: { cron: "*/10 * * * *" }
            workflow: pr-review
            onSuccess:
              merge:
                approve: true
                autoMerge: true
                mergeMethod: SQUASH
                maxFilesChanged: 10
                blockedPaths:
                  - src/core/contracts.ts
                  - docker/*
                blockedLabels:
                  - security
```

`onSuccess.approve` resolves the watched stage's pending approval through
Wake's own approval transition — the same one a human `/approved` comment
takes — when the child run completes `DONE` and no correlated PR carries the
verdict. The approval is idempotent, recorded as a run-completed event with
reason `watcher:approved`, and audited as an `approval.watcher-resolved`
decision. A child `REJECTED` verdict posts the review body as feedback and
moves the parent to `changes-requested` instead of approving; a `BLOCKED` or
`FAILED` child (no verdict could be rendered at all) leaves the parent's
pending approval untouched.

> **Current target configuration:** use a `pr.merge` Activity stage rather
> than `onSuccess.merge`. Its `with` block has `target`, `method`,
> `requireApproval` (default `true`), `requireChecks`, `autoMerge` (default
> `false`), `maxFilesChanged`, and `blockedPaths`. `requireApproval: false`
> is valid only with `autoMerge: true` after an independent review watch gate.
> In that mode pending checks are left to GitHub branch protection; failed and
> unknown checks are rejected. Wake enables native auto-merge and falls back
> to a direct merge only when GitHub reports the PR is already in clean status.

`onSuccess.merge` is an opt-in deterministic action for PR-review approvals:

| Property          | Type     | Description                                                       | Default |
| ----------------- | -------- | ----------------------------------------------------------------- | ------- |
| `approve`         | boolean                       | Submit a GitHub PR review with `APPROVE`                           | `false` |
| `autoMerge`       | boolean                       | Enable GitHub native auto-merge on the PR after policy passes      | `false` |
| `mergeMethod`     | `MERGE` \| `SQUASH` \| `REBASE` | Merge method requested when enabling `autoMerge`                 | `MERGE` |
| `maxFilesChanged` | number                        | Block when the PR changes more files than this limit               | unset   |
| `blockedPaths`    | string[]                      | Glob-style changed-path patterns that always block (`*` wildcard)  | `[]`    |
| `blockedLabels`   | string[]                      | Issue labels that always block this deterministic merge action     | `[]`    |

`mergeMethod` must match a method the repository actually allows (GitHub
repo settings: "Allow merge commits" / "Allow squash merging" / "Allow rebase
merging"). GitHub's auto-merge API defaults to `MERGE` when unspecified, which
fails outright on a squash-only or rebase-only repository — set this
explicitly to match your repo's settings rather than relying on the default.

`autoMerge` queues a merge that completes once required checks pass; GitHub
rejects that queue request when the PR has nothing left to wait for (checks
already green or skipped) — the common case for a small, fast-reviewed PR.
Wake detects that specific rejection and merges directly instead, using the
same `mergeMethod`, rather than treating it as a policy block.

The merge action only runs for Wake's bot-authored PR-review approval marker
on a correlated PR. It does not run for human `/approved` comments on the
issue thread. If a policy rule fails, Wake posts the reviewer message plus the
policy exception on the PR and moves the work item to `blocked`.

When `autoMerge` is enabled, configure GitHub branch protection with required
status checks. Wake delegates the final green-CI gate to GitHub native
auto-merge rather than polling CI in this merge action.

If `approve` or `autoMerge` fails against the provider (for example: GitHub
rejects a review approving the PR's own author with a 422 "Can not approve
your own pull request" when `implement` and `pr-review` share one bot
identity; or a repository's allowed merge methods reject the auto-merge
request), Wake treats that failure as a policy block rather than an
uncaught error — it posts the provider's own rejection message and moves the
work item to `blocked`, without retrying the identical doomed call forever.
`approve` and `autoMerge` are attempted independently: one failing doesn't
prevent the other from running or from an already-succeeded step being
recorded. If `approve` consistently fails because your implement and
pr-review workflows share one bot identity, either disable `approve` and rely
on `autoMerge` alone, or configure a second reviewer identity.

### ui

_Lives in `config.yaml`._

Optional settings for the read-only control-plane UI (`wake ui` / `npm run
ui`). All fields are optional and default to a loopback-only, tokenless
server:

```yaml
ui:
  enabled: false
  port: 4317
  token: null
  tunnel:
    enabled: false
    authToken: null
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
  `NGROK_AUTHTOKEN`. To avoid storing the token in `config.yaml`, leave this
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

_Lives in `config.yaml`._

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
- `wake:status.awaiting-approval`
- `wake:status.changes-requested`
- `wake:status.blocked`
- `wake:status.failed`
- `wake:status.completed`

Wake replaces only the `wake:status.*` label family and preserves unrelated issue labels. A
tick-time reconciliation pass keeps this label (plus `wake:stage.*`, `wake:workflow.*`,
`wake:frozen`, and `wake:scheduled-workflow`) converged on the work item's actual state every
tick, even if a delivery is lost or a human hand-edits a label.

`wake:auto` is an operator opt-in label for deterministic approval of eligible
approval-gated stages (a `DONE` run on a stage configured with
`skipApproval: false`). It has no effect unless the pending action's prompt
declared `allowAutoApproval: true`; with built-in prompts that means refine can
advance to implement automatically, while implement still waits for human or PR
review approval. Commenting `/yolo` or `/autoapprove` on the issue is a
Wake-recognized built-in shortcut that only adds `wake:auto`. It does not invoke
an agent and does not directly resolve a pending gate; removing the label turns
auto-approval back off. When auto-approval fires, Wake appends the same
`wake.run.completed` transition it would append for a human `/approved`, follows
the workflow stage's normal `onDone`, and records the decision as
`auto:approved`.

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

BLOCKED-question auto-resolution is configured with an ordinary stage watcher,
not a global approval setting. A watcher intended to answer blocked questions
should use `while.status: [blocked]` and `on.event: [wake.run.completed]` so it
fires after a run has entered `BLOCKED`; the watcher workflow can then decide
whether the configured question class is safe to answer, and any answer must be
delivered through the same reply/comment path as a human response. With no such
watcher configured, blocked items continue to wait for a human.

## Loading and Merging

Wake loads every `config.yaml`/`config.<label>.yaml` file from the Wake
home root (not `.wake/` — that hidden directory is durable runtime state,
not configuration) and deep-merges them in alphabetical filename order.
Missing fields fall back to built-in defaults.

Wake homes created before this file-splitting existed still have a single
combined `config.json`. Wake reads it directly whenever no `config*.yaml`
file is present — no migration step, and Wake never rewrites or renames it.
Once you add a `config.yaml` (by running `wake init` fresh, or by hand),
`config.json` is ignored.

Wake does not write resolved configuration back to disk. What's on disk is
exactly what you put there (plus schema defaults applied in memory) — there
is no tick-time normalization step to work around when hand-splitting files.

For sandbox debugging, `wake sandbox logs` tails Docker container logs for the durable sandbox. The sandbox entrypoint tees `wake start`, `wake ui`, and ngrok output to both `<wakeRoot>/.wake/logs/*.log` and container stdout so `docker logs` shows live tick diagnostics. File logs rotate at 20MB (keeping one `.1` backup); override with `WAKE_LOG_MAX_BYTES` and `WAKE_LOG_ROTATE_CHECK_INTERVAL_MS` (default five minutes) inside the container. `wake sandbox up`/`update` also pass Docker `json-file` log-driver limits (`max-size=10m`, `max-file=3`) as a second line of defense. Wake keeps structured run/event records durably, but raw sandbox stdout/stderr is treated as container log output rather than a Wake-managed on-disk archive.

For day-to-day local upgrades, use `wake sandbox build` followed by
`wake sandbox update`. That rebuilds the image and replaces the container while
preserving the mounted Wake home and sandbox home directories.

For example, to enable GitHub polling while keeping all other defaults:

```yaml
schemaVersion: 1
sources:
  github:
    enabled: true
    repos: [owner/repo]
```
