# Development

This guide covers local Wake development from a source checkout. It includes
the command shortcuts, sandbox setup, auth flow, UI startup, and GitHub polling
notes that are useful while the published-package getting-started path is still
being built.

## Local Commands

From the Wake repo root:

```bash
npm install
npm run verify
npm test
npm run tick
```

Useful commands:

- `npm run tick` runs one control-plane tick using fake ticketing-system data
  from `.wake/fixtures/issues.json` when present.
- `npm run lint` runs ESLint over the TypeScript and JavaScript source files.
- `npm run format` rewrites supported files with Prettier.
- `npm run format:check` verifies Prettier formatting without changing files.
- `npm run verify` runs linting, formatting checks, a TypeScript build, and the
  test suite. CI runs this command for pull requests and pushes to `main`.
- `npm run start` runs the resident loop.
- `npm run ui` runs the read-only control-plane UI, including the status bar,
  condition board, item detail, activity feed, config, and health views. It
  binds `127.0.0.1:4317` by default. See
  [docs/specs/control-plane-ui.md](specs/control-plane-ui.md) for the full
  design and `--port`, `--host`, and `--token` flags.
- `npm run smoke` runs a smoke test against the configured real runner.
- `npm run smoke:claude` runs a minimal Claude Haiku smoke test.
- `npm run smoke:codex` runs a minimal Codex smoke test with the lower-cost
  `gpt-5.4-mini` model.
- `npm run smoke:cursor` runs a minimal Cursor smoke test.
- `npm run smoke:claude -- --remote-control` starts a minimal remote-control
  Claude smoke session.

## Formatting Workflow

Use editor save hooks for formatting when available. They give both humans and
agents immediate feedback before changes are staged, which keeps review diffs
focused on the actual code change.

Commit hooks are useful as a final local guard, but they are intentionally not
required by this repo yet because Wake often commits from non-interactive agent
sessions where hook installation and shell startup behavior can vary. If hooks
are added later, prefer a lightweight pre-commit hook that runs `npm run lint`
and `npm run format:check`, leaving `npm run verify` and CI as the authoritative
full check.

## Configuration

Wake's behavior can be customized through its JSON config file. In the default
repo-local flow, Wake loads config from `.wake/config.json`. In the scaffolded
sandbox flow below, `wake init` creates `wake-home/config.json` and the
wrappers run Wake against that mounted home directory.

See [docs/configuration.md](configuration.md) for the full config structure and
available options. For current Claude, Codex, and Cursor runner capability
differences, see [docs/runner-comparison.md](runner-comparison.md).

## Sandbox Setup

The sandbox flow on this branch has three parts:

1. Scaffold a clean Wake home directory.
2. Build and start the persistent Docker sandbox from this repo checkout.
3. Run the first-time auth setup inside the container.

`wake init` and `wake sandbox ...` always run on the host; `dispatchMainCommand`
in [`src/main.ts`](../src/main.ts) routes runtime commands (`tick`/`start`/`ui`/
`smoke`/`correlate`) into the sandbox automatically once `docker/Dockerfile`
exists, unless `--host` is passed. The only local-development detail that still
points back at the repo checkout is `dev.repoRoot`, which `wake init` stores in
`wake-home/config.json` so `wake sandbox build` can build the Docker image from
source.

## 1. Scaffold A Clean Wake Home

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
- `prompts/` with one Handlebars template per action, such as `refine.md`
  and `implement.md`
- `wake.sh` / `wake.ps1` launchers
- `workspaces/`
- `.wake/` — hidden, holds everything internal/durable: `events/`, `state/`,
  `runs/`, `sources/`, `repos/`, `locks/`, `logs/`, `container-home/`

Note that `wake init` does not scaffold `docker/` at all — `docker/Dockerfile`
is written the first time you run `wake sandbox build` (see step 2 below),
from whichever `dev.mode` template applies.

Use an absolute path in `WAKE_HOME`.

**Upgrading an existing wake-home from the old flat layout:** this was a
breaking layout change with no migration tooling (a pre-release decision — see
`docs/superpowers/specs/2026-07-22-wake-home-restructure-design.md`). To
upgrade an existing wake-home by hand: create a `.wake/` directory inside it,
move `container-home/`, `logs/`, `events/`, `events-by-id/`, `state/`, `runs/`,
`sources/`, `locks/`, `control/`, `ledger.json`, `PAUSE`, and `transcripts/`
into it (`config.json`, `prompts/`, `workspaces/`, and the launchers stay where
they are); delete `docker/setup.sh` and `docker/log-command.sh` if present
(unused now — folded into the CLI); confirm `docker/Dockerfile`'s `ENTRYPOINT`
points at `sandbox-entrypoint`, hand-editing it if not (it's user-owned and
never auto-rewritten); then re-run `wake sandbox build` to pick up the new
entrypoint.

`wake init` records `dev.mode` in `config.json` — `"source"` when the
`repoRoot` it was run from is a full checkout (has `src/main.ts` and
`tsconfig.json`, i.e. this dev-checkout workflow), or `"packaged"` otherwise
(a plain `npm install -g @atolis-hq/wake` install). This governs which
`docker/Dockerfile` template `wake sandbox build` writes and whether
`wake sandbox self-update` is available (source mode only — see below). Force
a specific mode with `wake init --dev` or `wake init --packaged` if the
auto-detected mode doesn't match your intent, e.g. testing a local
`npm pack` install from a source checkout.

## 2. Build The Sandbox Image

After scaffolding, switch to the Wake home directory. `wake init` drops two
local-development launchers there:

- `wake.sh` for bash, Git Bash, WSL, and similar shells.
- `wake.ps1` for PowerShell.

Both wrappers are a one-line convenience that delegates to the global `wake`
binary with `--wake-root` set to the wrapper's own directory, so you can run
`./wake.sh tick` from inside `wake-home` instead of typing
`wake tick --wake-root .` yourself.

Routing — whether a command runs on the host or is forwarded into the sandbox
container via `sandbox exec` — is decided by `wake` itself based on
`--wake-root`, not by the wrapper scripts; see `wake --help` for details.

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

## 3. Start Or Update The Persistent Container

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
`wake-home` mount, including `/home/wake` auth state such as GitHub, Claude, and
SSH credentials.

### Auto-Starting The Resident Loop

By default, `sandbox.start.enabled: true` makes the container entrypoint start
`wake start --wake-root /wake` whenever `sandbox up`, `sandbox update`, or
`sandbox self-update` creates the container. Output is written to
`<wake-root>/logs/start.log`, and the entrypoint records the process id in
`<wake-root>/logs/start.pid` so self-update can verify the loop survived a
container replacement. If the resident loop exits unexpectedly, the entrypoint
restarts it after a short delay and refreshes `start.pid` with the new process
id.

### Auto-Starting The Control-Plane UI

Set `ui.enabled: true` and a `ui.token` in `wake-home/config.json`, or export
`WAKE_UI_TOKEN` before `sandbox up` or `sandbox update`, before bringing the
container up. The container's entrypoint starts `wake ui` automatically, bound
to `0.0.0.0` inside the container.

`sandbox up` and `sandbox update` publish that port to the host as
`127.0.0.1:<ui.port>`, defaulting to `4317`, so the UI is reachable at
`http://127.0.0.1:4317` once the container is running. Requests must include
`Authorization: Bearer <token>` or a `wake_ui_token` cookie.

To expose the same in-container UI through a public ngrok URL, set
`ui.tunnel.enabled: true` and either provide `ui.tunnel.authToken` or export
`NGROK_AUTHTOKEN` before `./wake.sh sandbox up` or `./wake.sh sandbox update`.
The entrypoint starts the ngrok CLI and writes the generated URL to
`<wake-root>/control-plane-ui-url`; GitHub comments link their `Wake` header to
that URL while the file exists.

See [docs/configuration.md#ui](configuration.md#ui) for the full config shape.

## 4. Run First-Time Auth Setup Inside The Container

```bash
./wake.sh sandbox setup
```

When configuring GitHub auth, consider using a dedicated GitHub identity for
Wake-managed agent work instead of your main personal account. This keeps
automated issue comments, PRs, and commits easy to distinguish from human
activity and lets you grant only the repository access Wake needs. It is an
optional best practice, not a hard requirement.

That script runs:

- `gh auth login`
- `gh auth setup-git`
- `ssh-keygen` for `/home/wake/.ssh/id_ed25519` if missing
- `claude auth login --claudeai`
- `codex login`

Because `/home/wake` is volume-mounted, the sandbox's `gh`, SSH, Claude, and
Codex auth state survives container restart and recreation.

## 5. Inspect Or Use The Running Sandbox

Open a shell:

```bash
./wake.sh sandbox exec
```

Run the resident loop in the foreground for local development or debugging.
The wrapper forwards this into the container. In normal sandbox operation, the
entrypoint already starts the resident loop automatically:

```bash
./wake.sh start
```

Run one tick manually. The wrapper forwards this into the container:

```bash
./wake.sh tick
```

Resume a recorded runner session inside the container workspace:

```bash
./wake.sh sandbox resume <session-id> --cwd "/wake/workspaces/<workId>"
```

`<workId>` is the work item's minted `work-<ulid>` identity — the same key used by
`state/<workId>.json`. Find it in the control-plane UI, or by grepping `state/`
for the issue number (the projection retains an `issue` snapshot for exactly this
kind of human lookup).

Tick locks include owner metadata and are self-healing. If a process dies while
holding the tick lock, the next tick reclaims the lock when the owner PID is no
longer alive or the lock is older than the configured runner timeout. Stale
`running` run records are also marked `FAILED` during the next tick so local
history and labels converge without manual cleanup.

## 6. Stop The Sandbox

```bash
./wake.sh sandbox down
```

`sandbox down` stops the container immediately. If an agent run may be in
progress, use the safe stop instead — it waits for any active run to finish
before stopping, so an in-flight `implement`/`refine` session isn't killed
mid-way:

```bash
./wake.sh stop
```

(equivalent to `./wake.sh sandbox stop`). It polls `.wake/runs/*.json` for any
`status: "running"` record and blocks until none remain, then stops the
container with a 60s grace period. Flags: `--timeout-ms` (give up waiting
after this long instead of blocking forever) and `--poll-interval-ms`.

### Self-update

Only available when `config.dev.mode` is `"source"` (the dev-checkout
workflow above) — a packaged install (`dev.mode: "packaged"`, or unset on an
older wake-home) gets a clear error pointing at the packaged-mode update path
instead: `npm install -g @atolis-hq/wake@latest && wake sandbox build && wake
sandbox update`.

Run from inside your **wake-home** directory (the one scaffolded by `wake
init`, containing `wake.sh`/`wake.ps1`/`config.json`) — like every other
sandbox lifecycle command (`build`/`up`/`down`), `self-update` is not an npm
script. Running it from the dev repo checkout instead (`npm run ...`) fails
with "Sandbox self-update requires config.dev.repoRoot", because that's the
one field that only exists in your scaffolded `config.json`, not in the repo:

```bash
cd /path/to/your/wake-home
./wake.sh sandbox self-update
```

`self-update` checks for a newer version tag on `origin`, and if found: waits
for any active run to finish (same mechanism as `wake stop`), checks out the
tag, builds a versioned image (`<sandbox.imageRepository>:<tag>`), replaces
the running container, verifies the entrypoint-managed `wake start` process is
running, and health-checks it with a real `tick` against a throwaway
`--wake-root`. On failure it rolls back to the last-known-good
image/tag, records the failed tag in `<wake-root>/self-update-ledger.json` so
it's never silently retried, and files a GitHub issue with the failure detail
via `gh issue create`.

Flags:

- `--force` — proceed even if the tag matches what's already applied, or is
  recorded as a known-bad tag.
- `--tag <tag>` — target an explicit tag instead of discovering the latest
  one (useful for testing/rehearsal).
- `--loop` — don't exit after one check; repeat forever, sleeping
  `--loop-interval-ms` (default 5 minutes) between checks. Each iteration is
  independent: a failed iteration (a transient git/docker error, for example)
  is logged and the loop continues rather than exiting, and a healthy no-op
  check (already on the latest tag) is cheap — it's just `git fetch --tags`
  plus a tag comparison, no rebuild.

Requires a clean git working tree in `config.dev.repoRoot` and `gh`
authenticated with permission to create issues on the repo.

**`self-update` (with or without `--loop`) runs on the host, not inside the
sandbox container.** It has to be able to stop and replace the very container
it might be updating, and the host `docker`/`git` CLIs aren't reachable from
inside the container. `wake stop`/`sandbox` are already routed to the host by
`dispatchMainCommand` itself, so this falls out of the existing routing — you
just need something on the host keeping the process alive.

To run it continuously with no external scheduler, start the loop as a
long-lived host process from your wake-home directory:

```bash
cd /path/to/your/wake-home
./wake.sh sandbox self-update --loop
```

Leave it running in a background terminal, a `tmux`/`screen` session, or a
dedicated terminal tab. It polls indefinitely until the process is stopped
(Ctrl+C, or killed) — there's no separate scheduler or cron job to configure.
If you want it to survive terminal closes or host reboots, wrap it with
whatever process supervisor you'd use for any other long-running host script
(e.g. `pm2 start ./wake.sh -- sandbox self-update --loop`, an `nssm`/Windows
service, or a systemd unit) — that's optional and outside Wake's own scope,
since Wake only owns what happens inside the loop, not how the host keeps a
process alive.

## GitHub Issues Polling

Wake can poll configured GitHub repositories when `sources.github.enabled` is
set to `true`. Authentication is resolved from the current GitHub CLI session
via `gh auth token`, and Wake routes work through configured named runners and
capability tiers. `--runner fake` remains available as a global local override.

GitHub Issues sync runs inside the normal tick path. Each tick polls GitHub,
translates provider payloads into canonical ticket events, appends those events,
rebuilds local projections, decides whether work is needed, and only then
invokes Wake.

The default smoke prompt is intentionally tiny:

```text
This is Wake, reply with "hi Wake only"
```
