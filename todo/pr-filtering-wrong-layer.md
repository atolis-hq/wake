# Move PR-exclusion from the GitHub client into policy-engine

Found during code review of feat/claude-invoker.

GitHub's `issues.listForRepo` API returns pull requests too (each PR is an
"issue" under the hood, distinguished only by a `pull_request` field on the
payload). Wake was picking up its own open PRs as fresh work items and
running `refine`/`implement` against them - fixed by filtering
`!('pull_request' in issue)` inside `listIssues()` in
`src/adapters/github/github-client.ts`.

That fix lives in the transport client rather than in
`src/core/policy-engine.ts`'s `isEligible`, which is meant to be the single
owner of "is this eligible work" decisions (deterministic routing/eligibility
rules, per docs/implementation.md's "Routing and policy" section). A future
second work source (a webhook-driven GitHub adapter, or a non-GitHub ticket
tracker merged into the same intake stream) would not automatically inherit
this exclusion, since it's tied to this one client method instead of the
shared eligibility policy.

When picked up: move the PR-exclusion check (or a more general "is this a
real ticket, not some other GitHub object" check) into `isEligible` in
policy-engine.ts, keyed off a field on the canonical ticket payload (e.g. add
an `isPullRequest` flag to the normalized ticket shape in
github-issues-work-source.ts's `normalizeTicketUpsert`, rather than silently
dropping PRs before they ever become an event). This also makes the
exclusion visible/auditable in the event stream instead of invisible upstream
filtering.
