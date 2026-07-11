# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Wake is

Wake is an autonomous agent control plane for software development. It coordinates local agent execution (`Eddy`) by taking work from external channels (e.g. GitHub issues), deciding the next lifecycle step deterministically, and launching/resuming local agent CLI sessions (Claude Code, Codex) only when agentic execution is actually needed. See `README.md` and `docs/vision.md`/`docs/architecture.md` for the full rationale; this file focuses on what's needed to work in the code.

## Commands

```bash
npm install
npm run build        # tsc -p tsconfig.json
npm test             # vitest run
npm run test:watch   # vitest watch mode
npm run verify       # build + test, run this before considering work done
npm run tick         # run one control-plane tick against .wake/ (fake ticketing data if no GitHub source configured)
npm run start        # run the resident loop
npm run smoke        # smoke test the configured real runner
npm run smoke:claude # minimal Claude Haiku smoke test (see prompt below)
npm run smoke:codex  # minimal Codex smoke test using gpt-5.4-mini
npm run smoke:cursor # minimal Cursor smoke test
npm run smoke:claude -- --remote-control  # remote-control smoke session
```

Run a single test file: `npx vitest run test/core/tick-runner.test.ts`
Run tests matching a name: `npx vitest run -t "some test name"`

CI (`.github/workflows/ci-cd.yml`) runs `npm ci && npm test` on push/PR to `main`, then auto-tags semantic versions on `main` pushes based on `(MAJOR)`/`(MINOR)` markers in commit messages.

## Architecture

### Module boundaries (`src/`)

- `domain/`: pure types, zod schemas, and the sentinel/stage vocabulary (no IO, no logic)
- `core/`: lifecycle orchestration, deterministic tick policy, and the resident-loop controller — this is "Wake" itself
- `adapters/`: filesystem IO, fake test harnesses, and real integrations (GitHub, Claude, Docker, git worktrees) behind the `core/contracts.ts` interfaces
- `lib/`: small focused utilities (paths, file locking, event envelope shaping, clock)
- `cli/`: `init`/`sandbox` command implementations invoked from `main.ts`

`main.ts` is the entrypoint and command dispatcher (`tick`, `start`, `init`, `sandbox`, `smoke`). It wires together the adapters selected by config/flags (`--runner`, `--wake-root`) into a `tickRunner` via `buildRuntime`.

### Adapter seams (`src/core/contracts.ts`)

Everything core depends on is an interface, with fake and real implementations selected at runtime:

- `WorkSource` / `OutboundSink` — pulls in ticket events and delivers outbound intents (`fake-ticketing-system.ts` vs `github-issues-work-source.ts`)
- `AgentRunner` — executes an `AgentAction` against a projection (`fake-runner.ts` vs `claude-runner.ts`)
- `WorkspaceManager` — prepares an isolated working directory for a run (`fake-workspace-manager.ts` vs `git-workspace-manager.ts`)

Fake adapters are permanent test harnesses, not throwaway stubs — they exist so `tick`/`start` can be exercised deterministically with zero token spend, and they double as the future adapter contract for new real integrations.

### Event-first, projection-driven flow

The durable record is an append-only event stream, not the projection:

1. an inbound source event (e.g. GitHub issue/comment) is ingested and written as an immutable event envelope (`events/<date>.jsonl`)
2. `projection-updater.ts` folds relevant events into a per-item projection (`state/<repo>/<issue>.json`)
3. `policy-engine.ts` reads the projection (plus a relevant event slice) and deterministically decides the next `AgentAction` / stage transition — no tokens spent here
4. `lifecycle-service.ts` applies the resulting stage transition
5. `tick-runner.ts` orchestrates one pass of the above and, when agentic work is required, invokes the `AgentRunner` with a compact projection summary plus recent events (not the full event log)
6. agent-produced outbound intents (status updates, questions, PR links) go back through the same event model via `OutboundSink`, so the agent never needs to know the delivery channel — Wake owns routing/formatting per sink

Stages (`domain/stages.ts`): `queue -> refine -> implement -> done`, with `blocked` for work awaiting human input. `AWAITING_APPROVAL` and `FAILED` are run statuses and do not change the current stage. Runner sentinels are `DONE` / `AWAITING_APPROVAL` / `BLOCKED` / `FAILED`, parsed from agent output via `domain/schema.ts`.

### Wake home (`.wake/`)

Wake owns a `.wake/` (or scaffolded `wake-home/`) directory: `config.json`, `ledger.json` (pause windows), `events/`, `state/`, `runs/`. Treat `state/` as a rebuildable projection, not source of truth — if projection logic changes, it should be derivable again from `events/`.

### Sandbox / Docker flow

`wake init <path>` scaffolds a Wake home outside the repo checkout with `config.json`, `prompts/`, `docker/`, and `wake.sh`/`wake.ps1` launchers. Those wrappers call back into this repo checkout via `dev.repoRoot` recorded at scaffold time, and forward runtime commands (`start`, `tick`, `smoke`) into the running container via `sandbox exec`; `init` and explicit `sandbox ...` subcommands run on the host. See `README.md` for the full `sandbox build` / `up` / `setup` / `exec` / `down` walkthrough.

### Claude smoke test

The minimal smoke prompt used by `smoke:claude` is intentionally trivial (`This is Eddy, reply with "hi Eddy only"`) to prove the CLI/session/remote-control plumbing without spending meaningful tokens — don't make it more elaborate.

## Working within the pluggable architecture

Wake's core selling point is being model/CLI/workflow-agnostic. This only holds if new capability is added behind the existing seams rather than by special-casing `core/`:

- New ticketing sources, runners, or workspace strategies must implement the interfaces in `src/core/contracts.ts` (`WorkSource`, `OutboundSink`, `AgentRunner`, `WorkspaceManager`). `core/` must never import a concrete adapter directly — only `main.ts`'s `buildRuntime` wires a concrete adapter in.
- If you change one of those interfaces, update the fake and the real implementation together (e.g. `fake-runner.ts` and `claude-runner.ts`), plus `buildRuntime`. They're kept deliberately symmetric so `tick`/`start` stay testable at zero token cost — don't let the fake drift into a stub that no longer exercises the real contract.
- **Wake decides, the agent runs.** The runner prompt must never ask the agent to choose a model, apply labels, or move stage. The agent's only outputs are code/PR/comments plus the sentinel (`DONE`/`BLOCKED`/`FAILED`); only the control plane applies state transitions, after parsing that result.
- **The tick is a pure function of durable state.** Never cache "what happened last tick" in process memory — if a decision needs it, persist it under `.wake/` first. This is what makes the resident loop crash/restart safe; don't add logic that only works if the process stays alive between ticks.
- **GitHub is half the state.** Labels can be edited by a human at any time. Reconcile labels → local projection at the start of every tick; GitHub wins for *stage*, local files win for *history/attempts*.


## Testing conventions specific to this repo

- Prefer exercising `core/` logic through the fake adapters (`createFakeRunner`, `createFileBackedFakeTicketingSystem`, `createFakeWorkspaceManager`) rather than mocking `core/contracts.ts` interfaces ad hoc — the fakes already model the real contract and are maintained for exactly this purpose.
- Any new runner invocation must set `--max-turns` and a wall-clock timeout — these are the only runaway-cost protections and must not be optional.
- Don't add retry-with-bigger-model logic on a failed run; a failed attempt should surface as `BLOCKED` (bad spec), not trigger silent model escalation.

# Documentation requirements
Whenever changing the cli command surface or config file options, you must update the relevant documentation, such as the `README.md` or `docs\configuration.md`. Keep changes minimal and scoped only to changes you made.
