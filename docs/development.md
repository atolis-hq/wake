# Development

This guide covers local Wake development from a source checkout: npm
scripts, formatting, and the source-checkout-specific parts of the sandbox
workflow (self-update, GitHub polling). For scaffolding a Wake home and
running the sandbox — both dev mode and packaged installs — see
[docs/getting-started.md](getting-started.md).

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
sandbox flow, `wake init` creates `wake-home/config.json` and the launchers
run Wake against that mounted home directory.

See [docs/configuration.md](configuration.md) for the full config structure and
available options. For current Claude, Codex, and Cursor runner capability
differences, see [docs/runner-comparison.md](runner-comparison.md).

## Sandbox

See [docs/getting-started.md](getting-started.md) for scaffolding a Wake home
and running `sandbox build`/`up`/`setup`. From a source checkout, use
`npx tsx src/main.ts init <path>` in place of `wake init` (this repo isn't
installed globally, so there's no `wake` binary on `PATH` unless you've also
done a global install separately).

### Self-update

Only available when `config.dev.mode` is `"source"` — a packaged install
(`dev.mode: "packaged"`, or unset on an older wake-home) gets a clear error
pointing at the packaged-mode update path instead: `npm install -g
@atolis-hq/wake@latest && wake sandbox build && wake sandbox update`.

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
