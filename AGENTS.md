# AGENTS.md

This file gives implementation guidance for Wake.

## What Wake is

Wake is an event-driven control plane for autonomous software development. It
turns external observations into durable work and resource facts, interprets
configured workflows deterministically, runs activities through local agent
CLIs when needed, and publishes results through integrations. The append-only
event journal is authoritative; projections are rebuildable read models.

## Commands

```bash
npm install
npm run build              # Type-check and embed the build version
npm run check:catalogue    # Validate functional decision catalogue coverage
npm run check:scenarios    # Validate scenario coverage
npm run check:specs        # Report module-specification drift
npm run lint:architecture  # Module manifests, vocabulary, and dependency boundaries
npm run lint
npm run format:check
npm run test:fast          # Unit suite
npm run test:integration
npm run test:e2e
npm run test:web
npm run verify             # Fast local verification gate
npm run verify:ci          # Full non-live CI verification gate
npm run tick               # One control-plane pass against the current Wake home
npm run start              # Resident loop
npm run ui                 # UI host
npm run smoke              # Configured runner smoke test
```

Run a focused test with `npx vitest run <path>` or
`npx vitest run -t "name"`.

Start with the smallest check that exercises the changed behavior. UI/API work
also needs the relevant surface test; domain/service work needs its focused
unit or integration coverage; persistence, runner, workflow, or provider work
needs the relevant E2E scenario. Use `npm run verify` for cross-cutting changes
or when explicitly requested. Before handoff, report the checks actually run.

E2E scenarios that use processes or filesystem fixtures run serially; use the
relevant E2E scenario when changing workflow, persistence, runner, or provider
behaviour. CI runs the `verify:ci` coverage as separate fast-verification,
integration, E2E, and web jobs, plus the Docker smoke job, on relevant changes.
Report focused checks run and checks intentionally left to CI.

## Architecture

Read the target module's `MODULE.md`, `module.json`, public `index.ts`, and
its relevant contracts before changing it. Historical plans, reports, ADRs, and
design notes do not describe the active implementation.

| Module | Responsibility |
| --- | --- |
| `kernel` | Event envelopes, identifiers, relations, clocks, and storage contracts. |
| `persistence` | Filesystem and in-memory journals, projections, checkpoints, and locks. |
| `work` | Work-item facts and projections. |
| `resources` | External-resource facts and work correlation. |
| `activities` | Activity contracts and PR/review activities. |
| `orchestration` | Compiled workflows, instances, activations, waits, watches, and retry policy. |
| `execution` | Runs, runner adapters, workspaces, leases, cancellation, recovery, and transcripts. |
| `control-plane` | Intake, bounded advancement, selection, schedules, quotas, and hosts. |
| `integrations` | Provider polling, translation, artifacts, and delivery. |
| `surfaces` | CLI, API, and web presentation. |
| `bootstrap` | Root config, paths, concrete composition, and production projections. |

Each module exposes only its `index.ts`. Bootstrap is the only place that knows
the complete application graph; it composes concrete runners, providers,
persistence, activity registry, projections, and surface applications.

Keep ownership explicit:

- A bounded module owns its event types, payload map, stream references,
  decoder/selector, and draft factory. Persisted events must be decoded before
  folding.
- Event types are tied to their permitted streams at compile time and runtime.
  A selector returns `null` for another namespace and rejects malformed events
  in its own namespace.
- Compare closed concepts through exported vocabulary values. Do not introduce
  magic strings for event types, stream kinds, statuses, outcomes, relations,
  or config keys.
- The journal is authoritative. Projections are pure, rebuildable, and
  registered in Bootstrap; surfaces never define or reconstruct events.
- Validate genuinely open provider payloads at the integration boundary, then
  translate them into typed internal contracts. Do not recover domain state
  with `Record<string, unknown>`, reflection, coercion, or synthetic envelopes.
- Activities execute work but do not decide workflow transitions. Orchestration
  accepts durable outcomes and applies the configured route.

The bounded operational flow is: integrations poll and translate observations;
the control plane runs `advanceOnce`; orchestration requests ready activities;
execution claims and runs them; orchestration accepts outcomes; integrations
react to artifacts and deliver outbound intents. Tick, resident, and scheduled
hosts share that control-plane advancement capability.

## Wake home and configuration

`--wake-root` defaults to the current directory. `resolveWakePaths` in
`src/bootstrap/paths.ts` is the source of truth for paths: durable data lives
under `.wake/` (events, projections, checkpoints, locks, transcripts, and
container home) while workspaces live at `workspaces/`.

The strict root config schema is in `src/bootstrap/config/root-schema.ts`.
Its sections are `work`, `resources`, `activities`, `orchestration`,
`execution`, `controlPlane`, `integrations`, `surfaces`, `transcripts`, and
`host`. `wake init` writes the current config/workflow/prompt/sandbox scaffold.

Runtime commands (`tick`, `start`, `ui`, `smoke`, `audit`, `correlate`, and
`validate-state`) delegate into the configured sandbox when its Dockerfile is
present unless `--no-sandbox` is supplied. `init` and explicit `sandbox`
commands run on the host.

## Implementation and testing conventions

- Keep concrete process, filesystem, and provider details in infrastructure
  modules; expose typed contracts through the owning module's public surface.
- Preserve permanent fake adapters and composed fakes as deterministic,
  zero-token test infrastructure. Prove production reachability through the
  composition root; a callback-mocked service test is not an E2E test.
- Runner invocations use the configured timeout. Do not implement silent
  retry-with-a-bigger-model behavior; bounded retry belongs to workflow policy.
- Keep comments short and rationale-focused. Do not narrate obvious code.

## Documentation requirements

When changing the CLI surface or configuration schema, update the relevant
current-state reference documentation. `README.md` and reference docs under
`docs/` must describe the system as it exists now. Do not rewrite ADRs,
historical designs, handoffs, plans, reports, `docs/superpowers/`,
`docs/vision-inputs/`, or specifications merely to reflect a later design.

Do not introduce mojibake; use valid UTF-8 or ASCII text.
