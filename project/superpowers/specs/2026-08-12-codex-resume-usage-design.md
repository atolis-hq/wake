# Codex resumed-run usage

## Decision

Wake records per-invocation token usage. A resumed Codex CLI invocation emits
a cumulative session usage snapshot, so Execution will derive the prior usage
baseline for the selected `(cli, sessionId)` and pass it with the runner
request. The Codex adapter will subtract that baseline from its final usage
snapshot before returning generic token usage.

## Scope

- Fresh Codex sessions record their final snapshot unchanged.
- Resumed Codex sessions record only the non-negative difference from their
  persisted baseline.
- A missing or inconsistent baseline leaves token usage absent rather than
  recording a negative or otherwise unreliable value.
- Claude is unchanged: its JSON result reports per-invocation usage.
- Cache read/write values remain diagnostic subsets of input usage. Aggregate
  token totals count input plus output only.
- No adapter estimates or manufactures dollar costs. An absent cost remains
  absent.

## Data Flow

1. Execution selects a resume session as it does today.
2. From the same eligible run set, it sums the already-recorded per-run token
   values for that CLI and session ID.
3. It supplies that sum only to the resumed runner request.
4. Codex parses its final `turn.completed` snapshot and subtracts the
   baseline field-by-field.
5. Agent metadata persists the resulting delta. Future resumes build their
   baselines from those deltas.

## Verification

Tests cover a fresh snapshot, a resumed snapshot delta, rejection of a
negative delta, Claude's unchanged parsing, and aggregate totals that do not
double-count cached input.
