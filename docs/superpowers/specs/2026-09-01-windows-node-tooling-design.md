# Windows Node Tooling Design

## Outcome

Make Wake's local Node development workflow reliable and faster on Windows without slowing CI or changing application runtime behavior.

## Hook management

Replace Husky and lint-staged with Lefthook. The pre-commit hook will select the same staged source and configuration file types as the current lint-staged configuration, invoke the repository's installed Prettier executable directly through Node, and restage formatted files. This removes the Windows `npx` shim from the Git hook path while preserving the current formatting behavior.

The npm-distributed Lefthook binary will install the repository hook. Husky's hook files, `prepare` script, dependency, and lint-staged dependency and configuration will be removed.

## ESLint performance

Run the existing repository-wide ESLint rules with content-based persistent caching. Store the cache below `node_modules/.cache` so it remains local and already ignored by Git. A cold run will retain current behavior; subsequent runs will lint only changed inputs where ESLint can safely reuse results.

## Test concurrency

Keep concurrency limits targeted:

- web and integration suites use at most four workers because their browser and filesystem fixtures showed contention on a high-core Windows host;
- architecture and E2E suites remain serial because they mutate or coordinate process/filesystem fixtures;
- unit tests retain normal parallelism because they completed successfully and benefit from it.

No concurrency setting affects production execution.

## Enforcement and verification

Add an architecture test that verifies:

- Lefthook is the configured hook manager;
- the pre-commit job formats and restages the intended staged files;
- Husky and lint-staged configuration and dependencies are absent;
- ESLint uses a content-based cache in an ignored local location;
- the targeted worker limits remain in place.

Verify configuration validation, a real pre-commit run against a staged formatting fixture, repeated ESLint execution, focused architecture tests, and the repository verification gate.
