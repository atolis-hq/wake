/**
 * Wake's branch-naming convention for a work item's implementation branch,
 * keyed on the originating ticket's issue number (spec D2 — human-readable,
 * not the opaque work id).
 *
 * Lives in domain/ (not the git adapter) because it is pure vocabulary with
 * no IO: `core/` needs it to compute the branch a run should have pushed to
 * when verifying agent-reported artifacts, and `core/` may import domain/
 * but never a concrete adapter directly. `adapters/git/git-workspace-manager.ts`
 * re-exports this for its own callers so existing imports keep working.
 */
export function branchNameForIssue(issueNumber: number): string {
  return `wake/issue-${issueNumber}`;
}
