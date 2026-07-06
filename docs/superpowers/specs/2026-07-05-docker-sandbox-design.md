# Docker Sandbox Packaging — Design

## Problem

Wake currently runs as a local `tsx`/`node` process directly against a repo
checkout. To match the vision of running execution "inside containerised
sandboxes," Wake needs to be packaged so its whole control plane (tick loop,
GitHub polling, Claude invocations, workspace clones) runs inside a
long-lived Docker container, with a separate GitHub/Claude identity from the
host user, while still letting a human drop into a live `claude --resume`
session for direct intervention.

npm packaging of the Wake CLI itself is out of scope for this iteration —
the CLI is invoked via a path into the existing repo checkout (e.g.
`npx tsx src/main.ts ...` or a thin shell shim), and that invocation
mechanism can be swapped for a published package later without changing the
sandbox home directory layout.

## Goals

- A `wake init` command that scaffolds a clean, non-repo host directory
  that *is* Wake's root (no nested hidden `.wake/`).
- A Dockerfile + build/up/down/exec/resume commands that run Wake's full
  control plane inside one persistent, named container per host.
- A first-run interactive setup path for `gh auth login`, SSH key
  generation, and Claude Code auth, since these require a human at a
  terminal and can't be baked into the image.
- Config (`config.json`) and prompt templates (`prompts/*.md`) that live in
  the host home directory, are bind-mounted into the container, and are
  editable without rebuilding the image.
- A way to jump into the running container and resume a specific Claude
  session at the right workspace path — resuming from the host doesn't
  work because the workspace only exists inside the container's mounted
  volume.
- A `setup.sh` script, copied into every scaffolded home directory, that
  documents/automates the container setup so anyone can stand up their own
  sandbox from scratch.

## Non-goals

- Publishing Wake to npm.
- Multiple concurrent named sandboxes on one host (single sandbox for now;
  naming is not hardcoded so this can be extended later).
- Wiring Wake's own internal resume-vs-fresh-session policy
  (`docs/todo/session-resume-policy.md`) — orthogonal to this work.
- Automated workspace retention/cleanup (`docs/todo/workspace-cleanup.md`)
  — orthogonal to this work.
- CI-verified Docker execution — Docker-dependent commands are smoke-tested
  manually; only their argument-construction logic is unit tested.

## A. Directory layout & CLI surface

`wake init [dir]` is run from inside the intended home directory (defaults
to `cwd`; an optional `dir` argument overrides the target). It scaffolds:

```
wake-home/
  config.json          # copied from defaults, includes a new `sandbox` section
  prompts/              # copied from repo's prompts/*.md — editable, no rebuild needed
  docker/
    Dockerfile           # copied from the repo's docker/Dockerfile
    setup.sh             # first-run interactive setup (gh auth, ssh-keygen, claude login)
  events/ state/ runs/ workspaces/ repos/ sources/ locks/   # same shape as today's .wake/*
```

Everything is copied, not linked, so a scaffolded home directory is fully
self-contained and independent of the repo checkout that created it.

New CLI surface, implemented under `src/cli/` (new module, separate from
the existing `src/main.ts` tick/start/smoke commands):

- `wake init [dir]` — scaffold the layout above
- `wake sandbox build` — `docker build` the image (build context is the
  wake repo checkout, not the home directory)
- `wake sandbox up` — create/start the named persistent container
- `wake sandbox down` — stop the container (state persists on the mounted
  volume; the container is not removed)
- `wake sandbox setup` — run first-run interactive auth (gh, ssh, claude)
  via `docker exec -it`
- `wake sandbox exec [-- cmd...]` — `docker exec -it` a shell (default) or
  an arbitrary command into the running container
- `wake sandbox resume [sessionId] [--cwd <workspacePath>]` — resume a
  Claude session inside the container (see section D)

Single sandbox per host for now: image/container names default to fixed
values (e.g. `wake-sandbox`), overridable via `config.json`'s `sandbox`
section. The design doesn't preclude a future named-sandbox extension, but
no selector UX is built now.

## B. Docker image & first-run setup

**Dockerfile** (`docker/Dockerfile` in the wake repo; build context is the
repo root):

- Base image: `node:20-bookworm-slim`
- `apt-get install`: `git`, `openssh-client`, `ca-certificates`, `curl`,
  plus the GitHub CLI (`gh`) via its official apt repository
- `npm install -g @anthropic-ai/claude-code`
- `COPY` the repo source in, `npm ci && npm run build`, so `dist/` ships
  baked into the image
- Runs as a non-root user (e.g. `wake`) with its own home directory, so
  `gh`, `ssh`, and `claude` config all land in predictable, per-user paths
- Entrypoint: `node dist/src/main.js start --wake-root <containerMountPath>`
  — the container's main process *is* Wake's resident loop

**First-run setup** (`wake sandbox setup`, backed by `docker/setup.sh`,
copied into every scaffolded home directory so the process is documented
and repeatable by anyone):

1. `docker exec -it <container> gh auth login` — interactive
   device/browser login for the sandbox's own GitHub identity
2. `docker exec -it <container> gh auth setup-git` — installs gh's git
   credential helper so HTTPS clones/pushes authenticate automatically
3. `docker exec -it <container> ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""`
   (skipped if a key already exists on the mounted volume), then print the
   public key and prompt the user to add it to the sandbox identity's
   GitHub account — for future SSH-based git operations
4. `docker exec -it <container> claude setup-token` (or equivalent
   interactive login) — establishes Claude Code's own auth inside the
   container

All of this state (`~/.ssh`, `gh` config, `claude` config) must survive
container recreation, so the container user's home directory is itself
bind-mounted from the host home directory (e.g.
`<home>/container-home` → `/home/wake`), not left in the image's
writable layer.

## C. Config & prompts externalization

**Config.** Add a `sandbox` section to `WakeConfig` / the zod schema in
`src/domain/schema.ts`:

```json
"sandbox": {
  "image": "wake-sandbox",
  "containerName": "wake-sandbox",
  "containerMountPath": "/wake",
  "containerHomeMountPath": "/home/wake"
}
```

`runner.claude.model` already exists and continues to govern model
selection — no new field needed there; editing the scaffolded
`config.json` is the supported way to change it, same as today.

**Prompts.** `promptsRoot()` in `src/adapters/claude/prompt-templates.ts`
currently always walks up from the module's own location to find
`package.json` and resolves `<repo>/prompts`. Change it to:

1. Accept an explicit prompts root, threaded through from
   `WakeConfig.paths.promptsRoot` (new optional field, defaulting to
   `<wakeRoot>/prompts` when the config's `paths.wakeRoot` is set to a
   sandbox home directory)
2. Fall back to the existing repo-relative lookup when
   `paths.promptsRoot` is absent, so existing tests and the current
   in-repo dev flow (`npm run tick`, etc.) are unaffected

`wake init` copies `prompts/*.md` from the repo into `<home>/prompts/` so
they're editable in place — the containerized Wake process reads them from
the mounted home directory, with no image rebuild required to change a
prompt.

## D. Lifecycle commands

**`wake sandbox up`:**
- Errors (suggesting `wake sandbox build`) if the image doesn't exist
- If the named container exists but is stopped, `docker start`s it
- If it doesn't exist, runs
  `docker run -d --name <containerName> -v <home>:<containerMountPath> -v <home>/container-home:<containerHomeMountPath> <image>`
- No-ops if already running

**`wake sandbox down`:** `docker stop <containerName>` — the container and
its mounted state persist; only the running process stops.

**`wake sandbox exec [-- cmd...]`:**
`docker exec -it <containerName> ${cmd:-bash}`.

**`wake sandbox resume [sessionId] [--cwd <workspacePath>]`:**
- With both `sessionId` and `--cwd` given: exec directly —
  `docker exec -it <containerName> bash -lc 'cd "<workspacePath>" && claude --resume <sessionId>'`
  — this mirrors exactly what Wake's GitHub comment already tells a human
  to run (`formatWakeComment` in `github-issues-work-source.ts`), just
  routed through the container instead of a bare host shell.
- With no arguments: scan `<home>/workspaces/**` for workspace directories,
  sort by mtime descending, cross-reference `<home>/runs/*.json` to find
  the most recent run (and its `session_id`) touching each workspace, and
  present an interactive picker (repo, issue, title, last-updated). Once
  chosen, resume that session the same way as the explicit-args path.

## Testing plan

- Unit test the new `src/cli/` argument parsing and command dispatch, and
  the `promptsRoot` fallback logic — pure functions, following the
  existing vitest conventions used elsewhere in the repo.
- Wrap `docker` invocations behind a small adapter under `src/adapters/`
  (mirroring the existing adapter boundary pattern), so the *arguments*
  passed to `docker build` / `run` / `exec` / `stop` can be unit tested
  against a fake, without needing a real Docker daemon in CI.
- Actual Docker build/run/exec behavior is verified manually (or via a
  follow-up smoke script, similar in spirit to `scripts/e2e-github-fake.ts`)
  rather than in the automated test suite.
- No changes to existing tick-runner, resume-policy, or workspace-cleanup
  behavior — this work is purely additive tooling around the container
  boundary.
