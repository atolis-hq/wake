import { describe, expect, it } from 'vitest';

import { workItemStatusForRunOutcome } from '../../src/domain/work-item-status.js';

describe('workItemStatusForRunOutcome', () => {
  it('maps a gated DONE to awaiting-approval', () => {
    expect(
      workItemStatusForRunOutcome({ sentinel: 'DONE', stage: 'implement', approvalGated: true }),
    ).toBe('awaiting-approval');
  });

  it('maps an ungated DONE on a non-terminal stage to queued', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'DONE', stage: 'implement' })).toBe('queued');
  });

  it('maps an ungated DONE on the terminal stage to done', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'DONE', stage: 'done' })).toBe('done');
  });

  it('maps REJECTED to changes-requested regardless of approvalGated', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'REJECTED', stage: 'implement' })).toBe(
      'changes-requested',
    );
  });

  it('maps BLOCKED to blocked', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'BLOCKED', stage: 'implement' })).toBe(
      'blocked',
    );
  });

  it('maps FAILED to failed', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'FAILED', stage: 'implement' })).toBe('failed');
  });
});
