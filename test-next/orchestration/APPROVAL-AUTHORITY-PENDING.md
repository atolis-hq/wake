# D16 approval authority — orchestration half is specified, not built

`approval-authority.test.ts.pending` is a complete failing-first specification for the
orchestration half of operator decision D16 (packet design §12.6). It is parked with a
`.pending` suffix because it does not compile against today's contracts, which would break
`build:next` and therefore `verify:next`.

**Already built and green:** the Work half — `work.auto-approval-granted` /
`work.auto-approval-revoked` events, idempotent `grantAutoApproval` / `revokeAutoApproval`
commands, the projection and domain fold, and `WorkItemView.autoApprovalGranted`.

**Still to build**, all named by the parked test:

- `ApprovalAuthorityKind` closed vocabulary and the `ApprovalAuthority` discriminated union
- a `WatchId` brand; `CompiledWatch.id` branded by `compileWorkflow`
- `await: { signal, from }` on an outcome route, compiled to `{ signal, from, resume }`
- watch references resolved against the workflow's declared `watches:`, failing compilation
  with a message naming the workflow, the stage and the unknown watch id
- acceptance rules: an unspecified authority is treated as `human`; `auto` requires BOTH the
  route declaring it AND operator consent on the WorkItem; a `watch` authority is accepted
  only for the watch the route names
- `SignalAccepted` carries the opening `authority` separately from actor provenance

To resume: rename the file back to `.ts` and make it pass without weakening it.
