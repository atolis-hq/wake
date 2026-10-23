import { expect, it } from 'vitest';
import { renderDelegatedBrief } from '../../../src/orchestration/domain/delegated-brief.js';
import { workId } from '../../support/identities.js';

it('renders the objective, criteria, outputs and granted artifacts a child is opened with', () => {
  expect(
    renderDelegatedBrief({
      objective: 'Add a.txt',
      criteria: ['a.txt contains alpha', 'No other file changes'],
      outputs: [
        { name: 'change', kind: 'change' },
        { name: 'notes', path: 'notes.md', required: false },
      ],
      context: [{ workItemId: workId('parent'), revisionId: 'brief-1' }],
    } as never),
  ).toBe(
    [
      'Assignment from your delegating parent: Add a.txt',
      '',
      'Acceptance criteria:',
      '- a.txt contains alpha',
      '- No other file changes',
      '',
      'Outputs to deliver:',
      '- change (change)',
      '- notes (artifact, optional)',
      '',
      'Artifacts granted to you (read each with wake_artifacts_read, passing its workItemId and revisionId; they are also in your artifact manifest):',
      `- ${workId('parent')} brief-1`,
    ].join('\n'),
  );
});

it('omits sections a child has nothing for', () => {
  const text = renderDelegatedBrief({
    objective: 'Investigate',
    criteria: ['Findings published'],
    outputs: [],
    context: [],
  } as never);

  expect(text).toBe(
    'Assignment from your delegating parent: Investigate\n\nAcceptance criteria:\n- Findings published',
  );
});
