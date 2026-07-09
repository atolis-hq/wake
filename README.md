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

### Supported CLIs

| CLI | Status |
| --- | --- |
| Codex | Supported |
| Claude | Supported |

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
- `npm run smoke` runs a smoke test against the configured real runner
- `npm run smoke:claude` runs a minimal Claude Haiku smoke test
- `npm run smoke:codex` runs a minimal Codex smoke test with the lower-cost `gpt-5.4-mini` model
- `npm run smoke:claude -- --remote-control` starts a minimal remote-control Claude smoke session

### Configuration

Wake's behavior can be customized through its JSON config file. In the default
repo-local flow, Wake loads config from `.wake/config.json`. In the scaffolded
sandbox flow below, `wake init` creates `wake-home/config.json` and the
wrappers run Wake against that mounted home directory. See
[docs/configuration.md](docs/configuration.md) for the full config structure
and available options. For current Claude-vs-Codex runner capability gaps, see
[docs/runner-comparison.md](docs/runner-comparison.md).

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

If a tick is ever stuck reporting `{"status": "locked"}` with no run actually
in progress (e.g. the process holding the tick lock was killed before it could
clean up), clear the stale lock file:

```bash
./wake.sh locks clear
```

A wall-clock timeout on the selected real runner (`runner.claude.timeoutMs` or
`runner.codex.timeoutMs`, see `docs/configuration.md`) now kills a hung CLI
invocation and marks the run `FAILED` before this
should ever be needed, but `locks clear` remains the manual escape hatch for
cases outside that (e.g. the container itself was restarted mid-run).

### 6. Stop the sandbox

```bash
./wake.sh sandbox down
```

## GitHub Issues Polling

Wake can poll configured GitHub repositories when `sources.github.enabled` is
set to `true`. Authentication is resolved from the current GitHub CLI session
via `gh auth token`, and Wake uses a fixed runner mode of `fake`, `claude`, or
`codex`.

GitHub Issues sync runs inside the normal tick path. Each tick polls GitHub,
translates provider payloads into canonical ticket events, appends those
events, rebuilds local projections, decides whether work is needed, and only
then invokes Eddy.

The default smoke prompt is intentionally tiny:

```text
This is Eddy, reply with "hi Eddy only"
```
