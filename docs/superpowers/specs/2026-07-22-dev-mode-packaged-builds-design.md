# dev.mode: source vs. packaged sandbox builds: design

- Date: 2026-07-22
- Status: proposed
- Implements: findings #9 and #12 of `SETUP-REPORT.md` ("Group B")
- Related: [CLI help and container naming design](2026-07-22-cli-help-and-container-naming-design.md) (independent, no shared code path)

## Purpose

`wake sandbox build` fails, confirmed by reproduction, for anyone who installs Wake via `npm install -g @atolis-hq/wake` and runs `wake init` — exactly the path the README's "Getting Started" recommends. The Dockerfile compiles from `config.dev.repoRoot` (`COPY . .` + `npm ci && npm run build`), but for a global npm install `repoRoot` is the pruned published package tree (`dist/`, `docker/`, `prompts/`, `README.md`, `LICENSE`, `package.json` — no `src/`, no `tsconfig.json`), so `tsc -p tsconfig.json` fails immediately (`error TS5058: The specified path does not exist: 'tsconfig.json'`).

The Dockerfile/build pipeline only ever worked for the separate, documented dev-checkout workflow (`docs/development.md`); `wake init` doesn't distinguish the two cases today and just records whatever directory it was run from as `dev.repoRoot`.

Same root cause silently breaks `wake sandbox self-update`, which also assumes `repoRoot` is a real git checkout (`git fetch --tags`, `git tag --list`, `git checkout <tag>`).

## Design

### `dev.mode` config field

`wakeConfigSchema`'s `dev` object gains:

```ts
dev: z.object({
  repoRoot: z.string().optional(),
  mode: z.enum(['source', 'packaged']).optional(),
}).default({}),
```

`wake init` decides `mode` once, by inspecting the resolved `repoRoot`: if it contains both `src/main.ts` and `tsconfig.json`, `mode: 'source'`; otherwise `mode: 'packaged'`. An override flag on `wake init` (`--dev` forces `'source'`, `--packaged` forces `'packaged'`) covers edge cases such as testing a local `npm pack` install, where the directory shape doesn't match the heuristic's assumption.

`mode` is left `optional()` rather than defaulted, since a missing value should never silently resolve to a working mode for an existing pre-this-change wake-home — see Migration below.

### Two Dockerfile templates

The repo's own `docker/` directory (published under the package's `files` allowlist, and used as the dev-checkout source of truth) gains a second file, `docker/Dockerfile.packaged`, alongside the existing `docker/Dockerfile`:

- `docker/Dockerfile` (existing, unchanged): `WORKDIR /app`, `COPY package*.json ./`, `RUN npm ci`, `COPY . .`, `RUN npm run build`.
- `docker/Dockerfile.packaged` (new): `RUN npm install -g @atolis-hq/wake@<version>`, where `<version>` is the exact version of the CLI that ran `wake init` (read from the running CLI's own `wakeVersion`/`package.json` at scaffold time, not `latest` — the container must match what the user had installed when they scaffolded, not drift on rebuild). No `tsc`, no `src/` copy.

`scaffoldWakeHome` (`src/cli/scaffold-assets.ts`) copies whichever template matches the decided `dev.mode` as `wake-home/docker/Dockerfile` — a wake-home always ends up with exactly one Dockerfile, matching today's scaffold shape (finding #14's Dockerfile-is-user-owned-and-never-auto-overwritten property is unchanged; this only affects what gets written once at `init` time).

Switching modes for an existing wake-home is not supported as a live operation — re-run `wake init` into a fresh directory, or hand-edit `dev.mode` and `docker/Dockerfile` together. No mode-switch tooling is built, consistent with finding #15's "no migration tooling for a pre-release layout/config change" decision.

### `wake sandbox self-update` gated on mode

`main.ts`'s existing `selfUpdate` dependency-bundle construction (the block that builds `git`/`issueReporter`/ledger callbacks passed into `runSandboxCommand`) adds `config.dev?.mode === 'source'` to its existing guard (`commandArgs[0] === 'self-update' && repoRoot !== undefined && repoRoot.length > 0`). When the command is `self-update` but mode is `'packaged'` (or unset — see Migration), `selfUpdate` stays `undefined`, and `sandbox-command.ts`'s existing `input.selfUpdate === undefined` branch throws — its message changes from the current generic `Sandbox self-update requires git/issueReporter/ledger dependencies` to:

```
Sandbox self-update requires dev.mode: "source". For a packaged install, update instead with:
  npm install -g @atolis-hq/wake@latest && wake sandbox build && wake sandbox update
```

No git command is attempted in packaged mode — the error fires before any of `self-update-command.ts`'s git calls run. No npm-registry-based self-update path is implemented in this change (explicitly out of scope, per the report's finding #12 — a future addition, not part of this spec).

### Migration for existing wake-homes

Existing `config.json` files (e.g. `wake-test`) predate this field and have no `dev.mode`. Per `wakeConfigSchema`'s self-healing behavior (new fields fill with defaults/undefined, rewritten on next command run), `dev.mode` simply reads as `undefined` — which the self-update gate above already treats the same as `'packaged'` (safe default: refuse self-update rather than run git commands against a repoRoot that was never confirmed to be a checkout). `wake sandbox build` for an existing wake-home with `dev.mode` unset keeps using whatever `docker/Dockerfile` is already sitting in that wake-home (user-owned, untouched) — this change does not retroactively rewrite it. A user hitting the original `tsc` failure on an old wake-home needs to either hand-set `dev.mode: "packaged"` and copy in the new packaged Dockerfile template, or re-run `wake init` into a fresh directory.

## Out of scope

- npm-registry-based `self-update` for packaged installs.
- Any live mode-switching command.
- The `.wake/` directory restructure and everything else in `SETUP-REPORT.md` outside findings #9/#12.

## Testing

- `scaffold-assets.test.ts`: mode detection for a source checkout (has `src/main.ts` + `tsconfig.json`) vs. a pruned package tree (doesn't), the `--dev`/`--packaged` override flags, and that the correct Dockerfile template is written to `wake-home/docker/Dockerfile` in each case with the version placeholder substituted correctly in packaged mode.
- `sandbox-command.test.ts`: `self-update` with `dev.mode: 'packaged'` (and with `dev.mode` unset) throws the new message and performs zero git calls; `dev.mode: 'source'` preserves today's behavior unchanged.

## Documentation

`docs/development.md`'s dev-checkout workflow section gets a short note that this is `dev.mode: "source"` and that `self-update` is unavailable outside it. README's "Getting Started" section gets a one-line mention that `wake init` auto-detects packaged vs. source mode and that `sandbox build` works out of the box for a plain `npm install -g` install (closing out the confirmed failure this spec fixes).
