Found while tracing why `wake start` appears idle between activity bursts.

Wake exposes `sources.github.polling.lookbackMs` in config and docs, but the
current GitHub polling adapter does not use it.

Root cause:
- `src/adapters/github/github-issues-work-source.ts` polls open issues and
  comments every tick, compares them against local state, and ignores the
  configured `lookbackMs` value entirely

Why this matters:
- the config suggests a behavior that does not exist
- operators may tune `lookbackMs` expecting faster or narrower polling with no
  effect
- the mismatch makes debugging resident-loop behavior harder

Follow-up options:
- implement `lookbackMs` in the GitHub polling path, or
- remove the config/documentation surface if snapshot comparison is the only
  intended mechanism

Whichever path is chosen, update docs/tests so the behavior matches the exposed
config.
