# Git-style `.wake/` restructure and CLI-folded sandbox routing: design

- Date: 2026-07-22
- Status: proposed
- Implements: findings #5, #6, #7, #10, #11, #13, #15 of `SETUP-REPORT.md` ("Group C")
- Related: [dev.mode design](2026-07-22-dev-mode-packaged-builds-design.md) — packaged-mode images already have a full `wake` binary installed, which this design's `wake sandbox-entrypoint` and folded launcher routing depend on regardless of which Dockerfile template is in use.

## Purpose

Today a wake-home has ~13 flat top-level entries, no obvious split between what a user edits/browses and what's pure internal state, and two disconnected sources of truth for "what does `wake` actually do here": the installed global binary (host-only, everything) and the generated `wake.sh`/`wake.ps1` launcher scripts (the only thing that routes runtime commands into the sandbox, hand-written into two template strings at `init` time and never updated by a CLI upgrade). The default `--wake-root` resolution (`cwd/.wake` for `tick`/`start`/`ui`, but plain `cwd` for `sandbox`/`init` — already inconsistent today) doesn't match where `wake init` actually scaffolds files, which is how a stray, disconnected `.wake/` directory gets created by a bare `wake` invocation from inside a wake-home.

This groups the decided restructure (finding #11), the wake-root default fix (findings #6/#10), folding launcher routing into the CLI (finding #7), and folding the three internal docker scripts into the CLI (finding #13) into one change, since they all touch the same scaffold/path/dispatch code and are a single breaking layout change to roll out together (finding #15: no migration tooling — existing wake-homes get manually restructured by hand as a one-off).

## Design

### 1. Directory layout (finding #11, decided)

`wake-home/` (the directory `--wake-root`/cwd points at) keeps only what a user edits or browses day-to-day:

```
wake-home/
  config.json
  wake.sh / wake.ps1        # or their replacement — see §3
  prompts/
  docker/                    # Dockerfile only — see §4
  workspaces/                # real per-work-item git checkouts, human-resumable
  .wake/                     # hidden: everything internal/durable/operational
    repos/                   # canonical mirror clones, force-reset every tick — disposable cache
    logs/
    container-home/          # sandbox $HOME backing (ssh keys, gh/claude/codex/cursor auth)
    events/
    events-by-id/
    state/
    runs/
    sources/
    locks/
    control/                 # tick-request.json
    ledger.json
    PAUSE
    transcripts/
```

### 2. `paths.ts`: split project root from data root

`createWakePaths(wakeRoot)` keeps taking a single `wakeRoot` argument (no call-site signature change) but internally computes `const dataRoot = join(wakeRoot, '.wake')` and re-bases every path that finding #11's table assigns to `.wake/` onto `dataRoot` instead of `wakeRoot`. Concretely: `containerHomeRoot`, `ledgerFile`, `pauseFile`, `tickRequestFile`, `tickLockFile`, `runnerLockFile`, `issueFixtureFile`, `transcriptsRoot`/`transcriptWorkDir`/`transcriptSessionDir`, `reposRoot`/`repoRoot()`, `sourceStateRoot`/`sourceStateFile()`, `workItemStateFile`/`archivedWorkItemStateFile`, `runFile`/`runDateFile`, `eventFile`/`eventEnvelopeFile`, `logFile`, `resourceIndexRoot`/`resourceIndexShardFile` all move under `dataRoot`. `configFile` and `workspaceRoot`/`workspaceDir` stay under `wakeRoot` directly. This is the single file every adapter/command already imports from (per the report's own note), so this is the only place path strings change — no adapter changes needed elsewhere, only path *values* shift.

### 3. Default `--wake-root` resolution + auto-delegation into the sandbox

All runtime-command call sites in `main.ts` (`tick`, `start`, `ui` — currently `resolve(cwd, '.wake')`) change their default to plain `resolve(cwd)`, matching what `sandbox`/`init` already default to today. This makes the default consistent across every command and matches where `wake init` actually scaffolds — `cwd/.wake` is no longer a meaningful fallback path at all; it's simply the internal data subdirectory `paths.ts` computes from whatever root was resolved.

Sandbox routing moves from the generated launcher scripts into `dispatchMainCommand` itself: for runtime commands (`tick`, `start`, `ui`, `smoke`, `correlate`), if the resolved wake-root contains `docker/Dockerfile`, `wake` auto-execs into `sandbox exec -- node <container-main> ... --wake-root /wake` the same way `wake.sh`/`wake.ps1` do today — unless `--host` is passed, which forces host execution (the pre-this-change behavior: run the command directly against the resolved wake-root, no Docker involved). `init`, `sandbox`, `stop` are unaffected — they already run on the host only. This makes the single installed `wake` binary the whole CLI; `wake.sh`/`wake.ps1` either disappear or become trivial one-line shims that just exec the global `wake` binary (kept only if a project wants a pinned local invocation — not load-bearing for routing anymore, so this is a minor decision left to implementation, not a design fork).

**Revision — Dockerfile scaffolding moves from `init` to first `sandbox build`.** The design as first drafted assumed `docker/Dockerfile` presence reliably signals "this project uses the sandbox," reusing today's `scaffoldWakeHome` behavior of unconditionally copying `docker/` at `init` time. That assumption doesn't hold: `wake init` scaffolds `docker/Dockerfile` for *every* wake-home today regardless of whether the user ever intends to run in a sandbox, so file presence alone can't distinguish "opted in" from "just what `init` always writes." Fixed by moving the Dockerfile write itself out of `init`:

- `scaffoldWakeHome` (`src/cli/scaffold-assets.ts`) stops copying `docker/` at all. `runtimeDirectoryNames`/`dockerAssetNames` no longer include it. `wake init` still decides and records `dev.mode` in `config.json` (per the [dev.mode design](2026-07-22-dev-mode-packaged-builds-design.md)) — that decision is cheap and harmless to make even if the user never touches the sandbox — it just no longer writes the file itself.
- `sandbox-command.ts`'s `build` subcommand, before calling `docker.build`, checks whether `wake-home/docker/Dockerfile` exists; if not, writes it from whichever template matches `config.dev.mode`, then builds. Every subsequent `build` leaves an existing Dockerfile untouched (still user-owned, per finding #14).
- `docker/Dockerfile` presence now means exactly "this project has run `sandbox build` at least once" — an accurate, no-config-flag signal for auto-delegation. A user who scaffolds a wake-home and never runs any `sandbox` command gets a `docker/`-less directory and bare `wake tick`/`start`/etc. run on the host with no `--host` flag needed, matching their actual intent.
- Existing wake-homes from before this change already have `docker/Dockerfile` written by the old `init` behavior — they auto-delegate immediately post-upgrade whether or not they'd ever actually used the sandbox. This is a one-time quirk of the manual restructure (finding #15: no migration tooling) — noted in the upgrade instructions (§5) as something to check: delete `docker/Dockerfile` by hand on restructure if the project was never actually using the sandbox and host-only execution is wanted without `--host` on every call.

### 4. Docker scripts folded into the CLI (finding #13)

Traced usage confirms three different actual behaviors today: `entrypoint.sh` is baked into the image at build time from `dev.repoRoot`/`COPY . .` (the wake-home's own scaffolded copy is dead — editing it does nothing); `setup.sh`/`log-command.sh` are invoked live at runtime from the mounted wake-home copy (editing them does take effect). None of the three contain project-specific content — they're pure Wake-internal automation with no legitimate per-project customization hook, unlike `Dockerfile` (which the README explicitly expects users to edit for their own repo's tooling, and which stays wake-home-owned).

- **`setup.sh` → `wake sandbox setup`**: ported to TypeScript using the existing `spawn`/`runCommand` pattern in `main.ts`. Same behavior — Codex home bootstrap, SSH keygen if missing, interactive y/N prompts (via Node `readline`) for `gh auth login`/`claude auth login --claudeai`/`codex login`/`agent login`. Invoked from inside the container the same way today's `bash /wake/docker/setup.sh` is (`sandbox-command.ts:202`), now as `node /app/dist/src/main.js sandbox-setup` (or equivalent internal entrypoint — exact subcommand name decided at implementation time, not load-bearing for this design).
- **`log-command.sh` → inlined into `wake sandbox exec`**: the wrap/mirror/scrub/redact logic (the `sed`-based secret redaction in particular — TOKEN/SECRET/PASSWORD/KEY env-var patterns and GitHub token prefixes) becomes tested TypeScript instead of an untested shell regex, callable as a function from `sandbox-command.ts`'s exec path rather than shelling out to a mounted script.
- **`entrypoint.sh` → `wake sandbox-entrypoint`**: ported to TypeScript — ngrok tunnel discovery/polling, the `wake start` supervise-and-restart loop, and conditional UI/start process spawning based on `WAKE_UI_ENABLED`/`WAKE_START_ENABLED` env vars. The Dockerfile's `ENTRYPOINT` becomes `["node", "/app/dist/src/main.js", "sandbox-entrypoint"]` (or the packaged-mode equivalent, `["wake", "sandbox-entrypoint"]`, since Group B's packaged Dockerfile installs the CLI globally). This works identically regardless of which `dev.mode` Dockerfile template built the image, since both end up with a working `wake`/`node .../main.js` inside the container.

End state: `wake-home/docker/` scaffolds only `Dockerfile`. The other three assets stop being copied by `scaffoldWakeHome` (`dockerAssetNames` shrinks to `['Dockerfile']`) and their logic ships centrally in `dist/`, fixed on every `wake` upgrade instead of frozen at `init` time — and becomes unit-testable.

### 5. Rollout (finding #15, decided)

Breaking change, by design. No migration script, no backwards-compatibility shim for the old flat layout. Existing wake-home directories get manually restructured by hand as a one-off when this ships — not worth building automated migration tooling for a pre-release layout change. The README/`docs/development.md` gain a short "upgrading from the flat layout" note describing the manual steps (move the `.wake/`-bound directories under a new `.wake/`, delete `docker/setup.sh`/`log-command.sh`/`entrypoint.sh`, re-run `wake init`'s Dockerfile-copy step or hand-edit `docker/Dockerfile` to the new `ENTRYPOINT`).

## Out of scope

- `wake doctor`/`wake config check` (Group D — depends on this restructure for what it reports on, built after).
- Any schema-version migration mechanism for `.wake/` data files (noted in the report as a future concern, not a live problem yet).
- Renaming `workspaces/` or changing its semantics — it stays exactly as it works today, just confirmed to remain at the visible top level.

## Testing

- `test/lib/paths.test.ts` (or wherever `createWakePaths` is currently tested): every path that moves under `.wake/` asserted against the new location; `configFile`/`workspaceRoot` asserted to stay at `wakeRoot` directly.
- `scaffold-assets.test.ts`: `runtimeDirectoryNames` reflects the new nesting; `wake init` no longer writes `docker/` at all (`dockerAssetNames` removed / scaffolding step deleted); generated launcher content (if launchers still exist as shims) reflects the simplified routing.
- `test/cli/main.test.ts`: default `--wake-root` resolution for `tick`/`start`/`ui` matches `sandbox`'s existing default (plain `cwd`, not `cwd/.wake`); `--host` bypasses auto-delegation; auto-delegation triggers only when `docker/Dockerfile` exists at the resolved root, and does **not** trigger for a freshly-`init`ed wake-home that has never run `sandbox build`.
- `sandbox-command.test.ts`: `build` writes `docker/Dockerfile` from the `dev.mode`-selected template on first run when absent, leaves it untouched on subsequent runs (see the dev.mode design's testing section for the template-selection cases themselves).
- New test coverage for the ported `setup.sh`/`log-command.sh`/`entrypoint.sh` logic — in particular the secret-redaction regex, which had zero test coverage as shell.

## Documentation

README's directory-layout description and "Local and inspectable" design-goal callout need updating to the new tree. `docs/development.md` gets the manual upgrade-from-flat-layout note. Any doc referencing `wake.sh`/`wake.ps1` as the required entry point gets updated to reflect that the global `wake` binary now routes itself.
