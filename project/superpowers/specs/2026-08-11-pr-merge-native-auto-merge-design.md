# PR Merge Native Auto-Merge Design

## Decision

Extend the existing `pr.merge` Activity rather than introduce a second merge
Activity. Its input gains `requireApproval` and `autoMerge`, both explicit
policy choices. The defaults preserve today's direct-merge behaviour:
`requireApproval: true` and `autoMerge: false`.

## Policy

`requireApproval` controls whether `pr.merge` requires a current,
provider-native accepted pull-request review before issuing an outbound
operation. A direct merge MUST continue to require that approval. The only
allowed approval bypass is `requireApproval: false` combined with
`autoMerge: true`; a workflow must use a successful independent review watch
as its preceding gate. Configuration validation MUST reject an unapproved
direct merge.

`requireChecks` retains two precise modes:

- For a direct merge, `true` requires Wake to observe passing checks now.
- For native auto-merge, `true` rejects known failing checks but permits
  pending checks. GitHub branch protection is the final authority that holds
  the merge until its required checks pass.

An unknown check state remains unsafe for a direct merge. Native auto-merge
may be enabled only when the provider accepts the request; provider rejection
is recorded as a blocked delivery result.

## Delivery

The Activity first performs the existing correlated-PR, revision, changed-file,
and blocked-path checks. With `autoMerge: false`, it emits the current direct
merge intent. With `autoMerge: true`, it emits a distinct enable-auto-merge
intent carrying the requested method.

The GitHub delivery adapter enables GitHub native auto-merge. If GitHub
rejects that request solely because the pull request is already immediately
mergeable, the adapter falls back to one direct merge request with the same
method. It MUST NOT fall back for failed checks, insufficient permissions,
unsupported merge methods, or any other provider failure.

## Dark Factory Use

The production dark-factory workflow will place a `pr.merge` stage after its
independent PR-review watch gate with:

```yaml
activity: pr.merge
with:
  target: primary
  method: squash
  requireApproval: false
  requireChecks: true
  autoMerge: true
  maxFilesChanged: 20
  blockedPaths:
    - src/core/contracts.ts
    - docker/*
    - .github/workflows/*
```

This route relies on a separate reviewer runner for code-review judgment and
on GitHub branch protection for CI. It neither posts a self-approval nor
considers an agent response itself to be a native GitHub approval.

## Verification

Tests cover: legacy direct-merge defaults; schema rejection of unapproved
direct merge; pending-check auto-merge admission; failed-check rejection;
native auto-merge delivery; immediate-merge fallback; and preservation of
non-fallback provider errors. An end-to-end workflow test proves the
dark-factory review gate reaches the autonomous merge activity only after the
review child succeeds.
