# Developing Wake

This guide is for a source checkout of Wake. For installing and operating a
Wake home, see [Getting started](getting-started.md),
[Configuration](configuration.md), and [Workflows](workflows.md).

## Local commands

From the repository root:

```bash
npm install
npm run build
npm run test:fast
npm run test:integration
npm run test:e2e
npm run test:web
npm run check:specs
npm run verify
npm run verify:ci
```

`npm run verify` is the fast local gate: functional-decision and scenario
coverage, specification and architecture checks, linting, formatting, a
TypeScript build, and the filesystem-free unit suite. Run selected integration
or E2E scenarios when a change touches those boundaries. `npm run verify:ci`
adds architecture, integration, non-live E2E, unused-code, and web tests. GitHub
Actions runs those CI lanes separately for faster, attributable feedback, then
runs the Docker smoke job. `npm run check:specs` reports module specifications
whose `asOf` checkpoint needs a source-grounded refresh.

`npm run tick`, `npm run start`, `npm run ui`, and `npm run smoke` invoke the
source entry point against the current Wake home. They use the current directory
unless `--wake-root` is supplied.

## Useful command reference

| Command | When to use it |
| --- | --- |
| `npx vitest run <path>` | Run one focused test file while developing a scoped behaviour change. |
| `npx vitest run -t "name"` | Run tests whose name matches a focused scenario. |
| `npm run test:unit` / `test:fast` | Run the unit suite. `test:fast` is the normal quick local suite. |
| `npm run test:integration` | Exercise composed services and durable infrastructure boundaries. |
| `npm run test:e2e` | Exercise serial, non-live end-to-end scenarios. |
| `npm run test:e2e:live` | Run live-provider E2E scenarios only when the required external setup is available. |
| `npm run test:architecture` | Run architecture-focused tests. |
| `npm run test:web` / `npm run build:web` | Test or build the web surface after web/API/view-model changes. |
| `npm run build` | Type-check and embed the source version. |
| `npm run build:docker` | Build the TypeScript and web artefacts used by the Docker image. |
| `npm run lint` / `npm run format:check` | Check linting or formatting without modifying files. |
| `npm run format` | Apply Prettier formatting across supported files. |
| `npm run lint:architecture` | Validate module manifests, contract vocabulary, and dependency boundaries. |
| `npm run check:catalogue` / `npm run check:scenarios` | Validate functional-decision catalogue and scenario coverage. |
| `npm run check:specs` | Detect module specifications that need source-grounded synchronization. |
| `npm run check:specs:report` | Report specification drift without failing an aggregate verification command. |
| `npm run knip` | Check unused files, exports, types, and dependencies. |
| `npm run verify` | Run the broad local verification gate before a cross-cutting handoff. |
| `npm run verify:ci` | Run the complete non-live Node.js CI gate. |
| `npm run tick` / `npm run start` | Run one control-plane pass or the resident loop against a Wake home. |
| `npm run ui` | Start the source UI host. |
| `npm run smoke`, `npm run smoke:claude`, `npm run smoke:codex`, `npm run smoke:cursor` | Smoke-test the configured default or a specific runner path. |

Use the narrowest command that proves the changed behaviour first. Add the
relevant integration or E2E scenario when changing workflow, persistence,
runner, or provider behaviour; use `npm run verify` when the change is
cross-cutting or before a broad integration handoff.

## Development CLI

To use this checkout without replacing a globally installed `wake`, link the
small `bin` package rather than the repository root:

```bash
npm install
cd bin && npm link && cd ..
wake-dev init ./wake-home
```

`wake-dev` executes this checkout's `src/main.ts` through its local `tsx`, so
each invocation picks up source changes without a build step. It accepts the
same commands as `wake`.

## Source-mode sandbox and self-update

After `wake-dev init <path>`, configure a source-mode Wake home explicitly in
its `config.yaml`:

```yaml
host:
  development:
    mode: source
    repoRoot: /path/to/wake
```

Source mode requires `repoRoot`. A packaged install uses `mode: packaged` (or
leaves development settings empty).

Run source self-update against the Wake home, not against the repository root:

```bash
wake-dev self-update --wake-root /path/to/wake-home
```

The update process pauses new control-plane work, drains or cancels active
runs within the configured host timeouts, updates the source checkout, builds
the configured sandbox image, restores service, health-checks it, and rolls
back a failed deployment while recording the failure. It requires a clean
source working tree and is unavailable in packaged mode.

If self-update repeatedly cannot recover the source checkout, repair the host
checkout manually with `git checkout main && npm ci`, then clear `pendingTag`
from `.wake/update-ledger.json` before retrying.

| Option | Meaning |
| --- | --- |
| `--tag <tag>` | Update to one explicit tag instead of discovering the latest eligible tag. |
| `--force` | Proceed when the tag is already applied or marked as a prior failed update. |
| `--loop` | Continue checking and applying updates until interrupted. |
| `--loop-interval-ms <ms>` | Positive loop delay in milliseconds; default `60000`. |

## Design boundaries

Read the target module's `MODULE.md`, `module.json`, public `index.ts`, and
current `SPEC.md` before changing it. Each bounded module owns its event types,
payload map, stream references, selector/decoder, and `create<Owner>EventData`
factory. The journal is authoritative; projections are rebuildable read models
registered in Bootstrap.

Use durable fakes and the composed Bootstrap graph for E2E work. Do not import
another module's internals or make a surface reconstruct an event. Reference
documents describe current behaviour only; ADRs, reports, plans, and designs
are historical records and should not be revised during ordinary implementation
work.
