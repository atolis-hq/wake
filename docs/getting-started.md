# Getting Started

Wake runs from a **Wake home** directory: a plain-file directory holding
`config.json`, `prompts/`, `workspaces/`, and a hidden `.wake/` for durable
internal state. There are two ways to get one running, depending on how you
installed Wake:

- **Packaged** — you installed `@atolis-hq/wake` from npm. This is the
  standard path for using Wake day to day.
- **Source (dev mode)** — you're working from a Wake source checkout. Use
  this if you're developing Wake itself.

`wake init` detects which one applies automatically and records it as
`dev.mode` in `config.json`. `--wake-root` defaults to the current directory
for every command, so the usual pattern is: `cd` into your Wake home, then
run `wake <command>` directly — no wrapper scripts, no need to pass
`--wake-root` yourself.

## Packaged: install and initialize

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

`wake init` scaffolds `config.json`, `prompts/`, and `workspaces/`. It does
not create `docker/` — that's written lazily by `wake sandbox build` (see
below).

## Source (dev mode): install and initialize

From a Wake source checkout:

```sh
npm install
cd bin && npm link && cd ..
```

`npm link` (run from `bin/`, which is its own tiny local package) registers
a `wake-dev` command on your `PATH` that runs `src/main.ts` live via this
checkout's own `tsx` — no build step, and every invocation picks up your
latest source changes immediately. It works from any directory (e.g. after
you `cd` into a wake-home), the same as the packaged `wake` binary. Linking
from `bin/` rather than the repo root keeps this independent of a real
`wake` install — running `npm link` from the repo root would overwrite the
global `wake` symlink with this checkout too, which isn't what you want if
you also use the published package.

```sh
wake-dev init ./wake-home
cd ./wake-home
```

`wake-dev init --dev` / `wake-dev init --packaged` force a specific
`dev.mode` if auto-detection ever picks the wrong one (e.g. testing a local
`npm pack` install from inside a source checkout).

## Build and start the sandbox

From inside the Wake home — `wake` for a packaged install, `wake-dev` from a
source checkout:

```sh
wake sandbox build
wake sandbox up
wake sandbox setup
```

- `sandbox build` writes `docker/Dockerfile` from the template matching your
  `dev.mode` (source-mode builds the image from your checkout; packaged-mode
  installs `@atolis-hq/wake` globally inside the image) and builds it.
  Existing `docker/Dockerfile` is never overwritten — it's yours to edit
  (add tools your repos need, etc.); rebuild with `sandbox build` after
  editing it.
- `sandbox up` starts the persistent container, mounting the Wake home at
  `/wake` and a durable `container-home` at `/home/wake` for auth state.
- `sandbox setup` runs first-time auth inside the container: GitHub, SSH
  keygen, Claude, Codex. Optional best practice: use a dedicated GitHub
  identity for Wake-managed work rather than your main account.

## Run it

```sh
wake tick     # one control-plane tick
wake start    # resident loop
wake ui       # control-plane UI (127.0.0.1:4317 by default)
wake stop     # graceful stop, waits for any active run to finish
```

(`wake-dev` in place of `wake` from a source checkout, same as above.)

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
  config.json              # edit this
  prompts/                 # edit these
  docker/Dockerfile         # edit this (written by first `sandbox build`)
  workspaces/                # real per-work-item git checkouts — browsable
  .wake/                     # hidden: durable internal state
    events/, state/, runs/, sources/, repos/, locks/, logs/, container-home/
```

Everything under `.wake/` is generated and rebuildable — safe to delete
(except `container-home/`, which holds sandbox auth state) if you want a
clean slate.

## Updating

**Packaged installs:**

```sh
npm install -g @atolis-hq/wake@latest
wake sandbox build
wake sandbox update
```

`sandbox update` preserves the mounted Wake home and `/home/wake` auth
state (GitHub, Claude, SSH credentials).

**Source checkouts** additionally have `wake sandbox self-update`, which
checks for a newer version tag on `origin` and updates the sandbox
automatically; see [docs/development.md](development.md#self-update) for
details. It's unavailable for packaged installs — use `sandbox build` +
`sandbox update` above instead.

## Recommended practices

- Use a separate git identity for Wake-managed agent work so automated
  commits are easy to distinguish from human ones.
- Treat the generated `docker/Dockerfile` as a starting point — add the
  tools your repositories and agents need, then rebuild.
