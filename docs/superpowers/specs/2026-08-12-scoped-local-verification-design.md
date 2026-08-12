# Scoped local verification

## Goal

Keep local feedback fast and proportionate while CI remains responsible for the
complete repository verification suite.

## Design

`CLAUDE.md` is the single source of repository guidance for agent verification.
It will replace its blanket local requirement to run `npm run verify`,
`npm run knip`, and `npm run test:web` before every task completes with a
change-scope matrix.

UI-only work requires focused UI coverage and a web build. Work that crosses a
web/API/view-model boundary also requires the relevant projection or API test
and the full web suite. Domain/service work requires relevant unit or
integration coverage and a build. Workflow, persistence, runner, and external
integration work additionally requires targeted E2E coverage.

CI remains the required broad gate for push and pull-request changes, running
the full verification suite, knip, and the web suite. Developers may run those
commands locally when investigating cross-cutting failures, but they are not a
routine per-task requirement.
