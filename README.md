# Wake

Wake is an autonomous agent control plane for software development. It watches the work channels your team already uses (GitHub issues today), decides each item's next lifecycle step with deterministic rules, and launches local coding-agent CLIs (Claude Code, Codex, Cursor) only when agentic execution is actually needed. There are no new tools, dashboards, or rituals to adopt: work is refined, implemented in an isolated git workspace, and gated for approval directly on the ticket — Wake asks questions, requests sign-off, and reports progress as issue comments and labels, and a human can pick up the exact agent session locally at any point.

Key callouts:

- **Wake decides, the agent runs.** Choosing the CLI, model, and stage transition is a zero-token control-plane decision; agents only do the work and report an outcome (`DONE` / `BLOCKED` / `FAILED`).
- **Event-sourced and restart-safe.** The durable record is an append-only event log; all other state is a rebuildable projection, and every tick is a pure function of durable state — the loop can crash and resume without losing its place.
- **Shares state honestly.** Ticket labels are half the state: humans can edit them at any time, and Wake reconciles rather than assuming it owns the tracker.
- **Pluggable by construction.** Work sources, agent runners, and workspace strategies sit behind small interfaces, with permanent fake adapters that keep the whole loop testable at zero token cost.
- **Local and inspectable.** Runs on your machine or in a Docker sandbox; config, events, and state live in a plain-file Wake home directory you can read with `cat`.

Two names to know: `Wake` is the control plane and decision-maker; `Eddy` is the execution identity Wake launches and manages.

Current runner capability differences are documented in
[docs/runner-comparison.md](docs/runner-comparison.md).

## Development

```bash
npm install
npm test
npm run tick
```

Useful commands:

- `npm run tick` runs one control-plane tick using fake ticketing-system data from `.wake/fixtures/issues.json` when present
- `npm run start` runs the resident loop
- `npm run ui` runs the read-only control-plane UI (status bar, condition board, item detail, activity feed, config, health) alongside the loop — binds `127.0.0.1:4317` by default; see [docs/specs/control-plane-ui.md](docs/specs/control-plane-ui.md) for the full design and `--port` / `--host` / `--token` flags
- `npm run smoke` runs a smoke test against the configured real runner
- `npm run smoke:claude` runs a minimal Claude Haiku smoke test
- `npm run smoke:codex` runs a minimal Codex smoke test with the lower-cost `gpt-5.4-mini` model
- `npm run smoke:cursor` runs a minimal Cursor smoke test
- `npm run smoke:claude -- --remote-control` starts a minimal remote-control Claude smoke session

### Configuration

Wake's behavior can be customized through its JSON config file. In the default
repo-local flow, Wake loads config from `.wake/config.json`. In the scaffolded
sandbox flow below, `wake init` creates `wake-home/config.json` and the
wrappers run Wake against that mounted home directory. See
[docs/configuration.md](docs/configuration.md) for the full config structure
and available options. For current Claude, Codex, and Cursor runner capability
differences, see [docs/runner-comparison.md](docs/runner-comparison.md).

## Sandbox Setup

The sandbox flow on this branch has three parts:

1. scaffold a clean Wake home directory
2. build and start the persistent Docker sandbox from this repo checkout
3. run the first-time auth setup inside the container

Today, the top-level `wake init` / `wake sandbox ...` CLI routing is not wired
through [`src/main.ts`](src/main.ts). The only local-development detail that
still points back at the repo checkout is `dev.repoRoot`, which `wake init`
stores in `wake-home/config.json` so `wake sandbox build` can build the Docker
image from source.

### 1. Scaffold a clean Wake home

Pick a directory that is not this repo checkout and does not already contain
files. Wake treats that directory itself as its home root.

Run the scaffold command from the Wake repo root.

Example:

```bash
export WAKE_REPO="/path/to/wake"
cd "$WAKE_REPO"
export WAKE_HOME="$HOME/wake-home"
npx tsx src/main.ts init "$WAKE_HOME"
```

That creates a self-contained home with:

- `config.json`
- `prompts/`
- `docker/Dockerfile`
- `docker/setup.sh`
- `events/`, `state/`, `runs/`, `workspaces/`, `repos/`, `sources/`, `locks/`

Use an absolute path in `WAKE_HOME`.

### 2. Build the sandbox image

After scaffolding, switch to the Wake home directory. `wake init` drops two
local-development launchers there:

- `wake.sh` for bash, Git Bash, WSL, and similar shells
- `wake.ps1` for PowerShell

Both wrappers call back into the repo checkout recorded at scaffold time, so
you can operate from `wake-home` instead of repeating the full `npx tsx
.../src/main.ts` path.

`init` and explicit `sandbox ...` commands run on the host. Other runtime
commands such as `start`, `tick`, and `smoke` are automatically
forwarded into the running container via `sandbox exec`. The wrappers default
the in-container Wake home to `/wake`, so you do not need to pass
`--wake-root` for normal scaffolded usage.

The build command reads `config.json`, uses `dev.repoRoot` for the Docker build
context, and keeps the operator flow rooted in `wake-home`.

```bash
cd "$WAKE_HOME"
./wake.sh sandbox build
```

PowerShell equivalent:

```powershell
Set-Location $env:WAKE_HOME
.\wake.ps1 sandbox build
```

### 3. Start or update the persistent container

Start the persistent container from inside `wake-home`:

```bash
./wake.sh sandbox up
```

If the container already exists and is stopped:

```bash
./wake.sh sandbox up
```

When you change Wake source or the Dockerfile and want the sandbox to pick up
the new version without losing mounted state, rebuild the image and replace the
container in place:

```bash
./wake.sh sandbox build
./wake.sh sandbox update
```

`wake sandbox update` is the normal upgrade path. It preserves the existing
`wake-home` mount, including `/home/wake` auth state such as GitHub, Claude,
and SSH credentials.

#### Auto-starting the control-plane UI

Set `ui.enabled: true` and a `ui.token` in `wake-home/config.json` (or export
`WAKE_UI_TOKEN` before `sandbox up`/`update`) before bringing the container
up, and the container's entrypoint starts `wake ui` automatically, bound to
`0.0.0.0` inside the container. `sandbox up`/`update` publish that port to the
host as `127.0.0.1:<ui.port>` (default `4317`), so the UI is reachable at
`http://127.0.0.1:4317` once the container is running — no manual `sandbox
exec` needed. Requests must include `Authorization: Bearer <token>` (or a
`wake_ui_token` cookie). If `ui.enabled` is true but no token is configured,
the entrypoint logs a warning and skips starting the UI rather than binding an
unauthenticated port. See [docs/configuration.md](docs/configuration.md#ui)
for the full config shape.

### 4. Run first-time auth setup inside the container

```bash
./wake.sh sandbox setup
```

That script runs:

- `gh auth login`
- `gh auth setup-git`
- `ssh-keygen` for `/home/wake/.ssh/id_ed25519` if missing
- `claude auth login --claudeai`
- `codex login`

Because `/home/wake` is volume-mounted, the sandbox's `gh`, SSH, Claude, and
Codex auth state survives container restart and recreation.

### 5. Inspect or use the running sandbox

Open a shell:

```bash
./wake.sh sandbox exec
```

Run the resident loop. The wrapper forwards this into the container:

```bash
./wake.sh start
```

Run one tick manually. The wrapper forwards this into the container:

```bash
./wake.sh tick
```

Resume a recorded runner session inside the container workspace:

```bash
./wake.sh sandbox resume <session-id> --cwd "/wake/workspaces/<repo>/<issue>"
```

Tick locks include owner metadata and are self-healing. If a process dies while
holding the tick lock, the next tick reclaims the lock when the owner PID is no
longer alive or the lock is older than the configured runner timeout. Stale
`running` run records are also marked `FAILED` during the next tick so local
history and labels converge without manual cleanup.

### 6. Stop the sandbox

```bash
./wake.sh sandbox down
```

## GitHub Issues Polling

Wake can poll configured GitHub repositories when `sources.github.enabled` is
set to `true`. Authentication is resolved from the current GitHub CLI session
via `gh auth token`, and Wake routes work through configured named runners and
capability tiers. `--runner fake` remains available as a global local override.

GitHub Issues sync runs inside the normal tick path. Each tick polls GitHub,
translates provider payloads into canonical ticket events, appends those
events, rebuilds local projections, decides whether work is needed, and only
then invokes Eddy.

The default smoke prompt is intentionally tiny:

```text
This is Eddy, reply with "hi Eddy only"
```
