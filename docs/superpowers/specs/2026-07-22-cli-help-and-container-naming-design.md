# CLI help/usage and per-project container naming: design

- Date: 2026-07-22
- Status: proposed
- Implements: findings #2 and #3 of `SETUP-REPORT.md` ("Group A" — smallest, independent onboarding-friction fixes)

## Purpose

Two confirmed onboarding rough edges from a fresh `wake init` + `wake sandbox build` walkthrough:

1. `wake` has no `--help`, bare `wake` (no args) silently defaults to running `tick` against `cwd/.wake` (creating a stray, un-scaffolded config tree if run from inside a wake-home directory instead of via the generated launcher), and unknown commands crash with a raw, uncaught `Error` and full stack trace.
2. `sandbox.image`, `sandbox.imageRepository`, and `sandbox.containerName` all default to the literal string `"wake-sandbox"`, so `wake init` in two different project directories produces colliding container identities — the second `sandbox up` either reuses the first project's container or fails, depending on state.

Both are small, independent fixes with no dependency on the larger `.wake/` layout restructure (deferred; see `SETUP-REPORT.md` findings #5–#15).

## Behavior changes

### 1. `--help` / `-h` / `help`

`dispatchMainCommand` (`src/main.ts`) gains a new first branch, checked before any existing command match: `--help`, `-h`, and `help` all print a usage summary via a new `printUsage()` helper and return (exit 0). The summary contains:

- One-line description of Wake
- The command list with one-liner descriptions: `init`, `sandbox <subcommand>`, `tick`, `start`, `stop`, `smoke`, `ui`, `correlate`, `version`
- The two entry points: run `wake init <path>` once, then use the generated `./wake.sh` / `./wake.ps1` launcher for day-to-day runtime commands (`tick`, `start`, `ui`, `smoke`, `correlate`) — the bare global `wake` binary runs those directly on the host, outside any sandbox.

### 2. Bare `wake` prints help instead of defaulting to `tick`

`const command = input.args[0] ?? 'tick'` becomes `const command = input.args[0] ?? 'help'`.

This is a deliberate behavior change: anyone currently relying on bare `wake` implicitly running `tick` must now say `wake tick` explicitly. This is the direct fix for the stray-`.wake/`-directory footgun (a curious first invocation of bare `wake` from inside a wake-home directory no longer silently runs a tick against the wrong root).

### 3. Unknown command: clean error, no stack trace

New `class CliUsageError extends Error` in `src/main.ts`. The final `throw new Error(...)` branch in `dispatchMainCommand` becomes:

```ts
printUsage(process.stderr);
throw new CliUsageError(`Unknown command: ${input.args.join(' ')}`);
```

`main()`'s top-level catch distinguishes it:

```ts
main().catch((error) => {
  if (error instanceof CliUsageError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
```

Genuine internal errors (anything not a `CliUsageError`) keep today's full-stack-trace behavior unchanged. `dispatchMainCommand` keeps its existing throw-based contract — no return-value/exit-code plumbing added to its signature — so existing callers/tests that already exercise it via `await dispatchMainCommand(...)` are unaffected except for the new branches.

### 4. Per-project default `containerName`

`scaffoldWakeHome` (`src/cli/scaffold-assets.ts`) computes a sanitized container name from the wake-root directory's basename and passes it as an override into config construction, so it's written once into `config.json` at `init` time (not re-derived on every load):

```ts
function sanitizeContainerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'wake';
}

const containerName = `wake-sandbox-${sanitizeContainerName(basename(wakeRoot))}`;
```

`createDefaultWakeConfig` gains an optional override parameter (or `scaffoldWakeHome` merges `sandbox: { containerName }` into the object passed to `parseWakeConfig`, mirroring how `dev.repoRoot` is already merged in today). `sandbox.image` and `sandbox.imageRepository` are **not** changed — they stay the shared literal default `"wake-sandbox"`, since the image itself is generic and only container identity needs to be unique per project.

No collision detection against a live Docker daemon and no path-hash suffix — dirname-derived only. Two wake-homes with the same directory basename in different locations can still collide; this is an accepted, documented limitation (a user hitting it can manually edit `config.json`), not a goal of this change.

## Out of scope

Everything else in `SETUP-REPORT.md` (directory restructure, `dev.mode`, `wake doctor`, folding launcher/docker scripts into the CLI, upgrade drift detection) — tracked separately, not touched by this change.

## Testing

- `test/cli/main.test.ts`: cases for `--help`, `-h`, `help`, and bare `args: []` all printing usage and not invoking any `run*` handler; unknown command throwing `CliUsageError` with the expected message and not falling through to any `run*` handler.
- A separate small test (co-located with `main.ts`'s error handling, or inline in `main.test.ts` if `main()` itself is reasonably testable) asserting the catch handler's branch — `CliUsageError` → message only vs. other `Error` → full error — if `main()` is structured in a way that's practical to unit test; otherwise this is covered by manual verification (`wake bogus-command` showing a clean one-line error, no stack).
- `test/cli/scaffold-assets.test.ts`: new case asserting the `containerName` written into `config.json` matches the sanitized wake-root dirname, plus a case covering sanitization of a dirname with spaces/uppercase/special characters.

## Documentation

README's "Getting Started" section gets a short pointer ("run `wake --help` any time for the full command list") near the existing command walkthrough — no structural rewrite, since the command surface itself isn't changing, only its discoverability.
