?# Getting Started

Wake runs from a **Wake home** directory: a plain-file directory holding
`config.yaml`, `config.workflows.yaml`, `prompts/`, `workspaces/`, and a hidden `.wake/` for durable
internal state. `--wake-root` defaults to the current directory for every
command, so the usual pattern is: `cd` into your Wake home, then run
`wake <command>` directly — no wrapper scripts, no need to pass
`--wake-root` yourself.

Developing Wake itself, from a source checkout? See
[docs/development.md](development.md) for that setup instead.

## Install and initialize

```sh
npm install -g @atolis-hq/wake
cd ~/
wake init ./wake-home
cd ./wake-home
```

Or run it once without installing globally:

```sh
npx @atolis-hq/wake init ./wake-home
```

`wake init` scaffolds `config.yaml`, `config.workflows.yaml`, `prompts/`,
`workspaces/`, `docker/`, and a `SETUP.md` guide written for an assisting agent
to use to finish configuring external integrations, runner/runnerPool, and
credential mounts. Point your agent CLI at it (for example, "read SETUP.md and
help me configure this") once `wake init` finishes.

## Build and start the sandbox

From inside the Wake home:

```sh
wake sandbox build
wake sandbox up
wake sandbox setup
```

- `sandbox build` writes `docker/Dockerfile` from the template matching your
  `host.development.mode` and builds it. Existing `docker/Dockerfile` is never
  overwritten — it's yours to edit (add tools your repos need, etc.);
  rebuild with `sandbox build` after editing it.
- `sandbox up` starts the persistent container, mounting the Wake home at
  `/wake` and a durable `container-home` at `/home/wake` for auth state.
  The container supervises the resident loop and restarts it automatically
  if it exits (for example because sandbox auth isn't configured yet) — the
  container itself never exits, so `sandbox setup` and `sandbox exec` can
  always reach it.
- `sandbox setup` runs first-time auth inside the container: GitHub, SSH
  keygen, Claude, Codex. Optional best practice: use a dedicated GitHub
  identity for Wake-managed work rather than your main account.

## Run it

```sh
wake tick     # one control-plane tick
wake start    # resident loop
wake ui       # control-plane UI (127.0.0.1:4317 by default)
wake stop     # graceful stop, drains active work and stops the sandbox
```

Once `docker/Dockerfile` exists (i.e. after `sandbox build`), these commands
automatically exec into `wake sandbox exec` instead of running on the host —
no separate launcher needed. Pass `--no-sandbox` to force host execution
even when a sandbox is available. See `wake --help` for the full command
list.

## Check your setup

```sh
wake doctor
```

Run after `wake init` and `wake sandbox build`. Checks prompt/runner config,
GitHub token resolvability, and Docker/sandbox reachability (failures).
Also reports, without failing, sandbox-vs-CLI version drift and any
prompt/Dockerfile customizations that have drifted from the shipped
defaults (notices).

## Directory layout

```
wake-home/
  config.yaml           # infra/sandbox/sources — edit this
  config.workflows.yaml # runners/runnerPools/workflows — edit this
  prompts/              # edit these
  SETUP.md              # agent-directed config guide
  docker/Dockerfile     # edit this (written by first `sandbox build`)
  workspaces/           # real per-work-item git checkouts — browsable
  .wake/                # hidden: durable internal state
    events/             # authoritative append-only journal
    projections/        # rebuildable read models
    checkpoints/        # rebuildable integration progress
    locks/              # coordination state
    transcripts/        # optional raw agent I/O capture
    logs/               # operational logs
    container-home/     # persistent sandbox-home state
```

The journal under `.wake/events/` is authoritative and must be retained.
Projections and checkpoints are rebuildable; `container-home/` holds sandbox
auth state. See [Architecture](architecture.md) before removing any durable
data.

## Updating

```sh
npm install -g @atolis-hq/wake@latest
wake sandbox build
wake sandbox update
```

`sandbox update` preserves the mounted Wake home and `/home/wake` auth
state (GitHub, Claude, SSH credentials).

## Recommended practices

- Use a separate git identity for Wake-managed agent work so automated
  commits are easy to distinguish from human ones.
- Treat the generated `docker/Dockerfile` as a starting point — add the
  tools your repositories and agents need, then rebuild.
