import { describe, expect, it } from 'vitest';

import { autoApprovalLabel, resolveAutoApprovalIntent } from '../../src/core/approval-intents.js';

describe('approval intents', () => {
  it('recognizes built-in auto-approval opt-in commands', () => {
    expect(resolveAutoApprovalIntent('/yolo')).toEqual({
      kind: 'auto-approval-opt-in',
      label: autoApprovalLabel,
      command: 'yolo',
    });
    expect(resolveAutoApprovalIntent('Looks good\n/AUTOAPPROVE')).toEqual({
      kind: 'auto-approval-opt-in',
      label: autoApprovalLabel,
      command: 'autoapprove',
    });
  });

  it('matches commands only at the start of a trimmed line', () => {
    expect(resolveAutoApprovalIntent('Please /yolo this')).toBeNull();
    expect(resolveAutoApprovalIntent('`/autoapprove`')).toBeNull();
    expect(resolveAutoApprovalIntent(undefined)).toBeNull();
  });
});
