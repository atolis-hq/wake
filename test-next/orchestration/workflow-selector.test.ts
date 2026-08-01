import { describe, expect, it } from 'vitest';
import { MatchMode } from '../../src-next/kernel/index.js';
import {
  compileWorkflowSelectors,
  selectWorkflow,
  workflowName,
  type WorkflowCandidate,
} from '../../src-next/orchestration/index.js';

const fallback = workflowName('default');

function candidate(overrides: Partial<WorkflowCandidate> = {}): WorkflowCandidate {
  return { tags: [], ...overrides };
}

describe('selectWorkflow', () => {
  it('returns the first matching selector', () => {
    const selectors = compileWorkflowSelectors([
      { match: { tags: ['review'] }, matchMode: MatchMode.Any, workflow: 'review' },
      { match: { tags: ['review'] }, matchMode: MatchMode.Any, workflow: 'later' },
    ]);

    expect(selectWorkflow(candidate({ tags: ['review'] }), selectors, fallback)).toBe(
      workflowName('review'),
    );
  });

  it('falls through to the configured default when none match', () => {
    const selectors = compileWorkflowSelectors([
      { match: { tags: ['review'] }, matchMode: MatchMode.Any, workflow: 'review' },
    ]);

    expect(selectWorkflow(candidate({ tags: ['bug'] }), selectors, fallback)).toBe(fallback);
  });

  it('AND-s separate keys and OR-s within a list under the default any mode', () => {
    const selectors = compileWorkflowSelectors([
      {
        match: { kind: ['pull-request'], tags: ['bug', 'urgent'] },
        matchMode: MatchMode.Any,
        workflow: 'triage',
      },
    ]);

    expect(
      selectWorkflow(candidate({ kind: 'pull-request', tags: ['urgent'] }), selectors, fallback),
    ).toBe(workflowName('triage'));
    // Same tag, wrong kind: separate keys are AND-ed, so the selector must not match.
    expect(
      selectWorkflow(candidate({ kind: 'issue', tags: ['urgent'] }), selectors, fallback),
    ).toBe(fallback);
  });

  it('requires every list member under all mode', () => {
    const selectors = compileWorkflowSelectors([
      { match: { tags: ['bug', 'urgent'] }, matchMode: MatchMode.All, workflow: 'triage' },
    ]);

    expect(selectWorkflow(candidate({ tags: ['bug'] }), selectors, fallback)).toBe(fallback);
    expect(selectWorkflow(candidate({ tags: ['urgent', 'bug'] }), selectors, fallback)).toBe(
      workflowName('triage'),
    );
  });

  it('matches on adapter id with no tags involved', () => {
    const selectors = compileWorkflowSelectors([
      { match: { adapter: ['secondary'] }, matchMode: MatchMode.Any, workflow: 'review' },
    ]);

    expect(selectWorkflow(candidate({ adapter: 'secondary' }), selectors, fallback)).toBe(
      workflowName('review'),
    );
    expect(selectWorkflow(candidate({ adapter: 'primary' }), selectors, fallback)).toBe(fallback);
  });

  it('never accepts a workflow name proposed by an adapter', () => {
    const selectors = compileWorkflowSelectors([]);
    const proposed = { tags: [], workflow: 'adapter-choice' } as WorkflowCandidate;

    expect(selectWorkflow(proposed, selectors, fallback)).toBe(fallback);
  });
});
