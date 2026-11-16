import { describe, expect, it } from 'vitest';
import { prerequisiteRevisions } from '../../../src/orchestration/application/prerequisite-revisions.js';

type Fact = Parameters<typeof prerequisiteRevisions>[0][number];

const fact = (eventType: string, payload: object): Fact =>
  ({ stream: { id: 'child' }, event: { eventType, payload } }) as unknown as Fact;
const request = (activationId: string, stage: string, workspace = 'branch') =>
  fact('orchestration.activity-requested', { activationId, stage, execution: { workspace } });
const gate = [
  fact('orchestration.signal-wait-started', {
    signalKind: 'orchestration.watch-gate-verdict',
    from: [{ kind: 'watch', watch: 'review' }],
    onRejectResume: { kind: 'stage', stage: 'revise' },
  }),
  fact('orchestration.signal-accepted', {
    kind: 'orchestration.watch-gate-verdict',
    outcome: 'rejected',
    authority: { kind: 'watch', watch: 'review' },
  }),
];

describe('prerequisiteRevisions', () => {
  it('keeps retried and follow-on branch activations in the revision episode', () => {
    const { revisions, pending } = prerequisiteRevisions([
      request('implement', 'implement'),
      ...gate,
      request('revise-1', 'revise'),
      request('revise-2', 'revise'),
      request('polish', 'polish'),
    ]);
    expect([...revisions.get('child')!]).toEqual(['revise-1', 'revise-2', 'polish']);
    expect(pending.get('child')).toBe('polish');
  });

  it('closes the episode at the next wait and ignores non-branch work', () => {
    const { revisions } = prerequisiteRevisions([
      ...gate,
      request('revise-1', 'revise'),
      request('lookup', 'lookup', 'none'),
      fact('orchestration.signal-wait-started', { signalKind: 'orchestration.watch-gate-verdict' }),
      request('later', 'revise'),
    ]);
    expect([...revisions.get('child')!]).toEqual(['revise-1']);
  });
});
