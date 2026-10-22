import { expect, it } from 'vitest';
import type { AgentContextAssignment, AgentContextReader } from '../../../src/activities/index.js';
import { withDelegatedAssignment } from '../../../src/bootstrap/delegated-assignment-context.js';

const assignment: AgentContextAssignment = {
  objective: 'Create a.txt',
  criteria: ['a.txt contains alpha', 'No other file is touched'],
  outputs: [{ name: 'change', kind: 'change' }],
  context: [{ workItemId: 'work-1', revisionId: 'artifact-1' }],
};
const reader = (title: string, body: string): AgentContextReader => ({
  async forWorkItem() {
    return { title, body, comments: [] };
  },
});

it('supplies the assignment as ticket text for a delegated child with no ticket', async () => {
  const wrapped = withDelegatedAssignment(reader('', ''), async () => assignment);
  expect(await wrapped.forWorkItem('work-2')).toEqual({
    title: 'Create a.txt',
    body: 'Acceptance criteria:\n- a.txt contains alpha\n- No other file is touched',
    comments: [],
    assignment,
  });
});

it('keeps provider ticket text authoritative and still attaches the assignment', async () => {
  const wrapped = withDelegatedAssignment(
    reader('Real title', 'Real body'),
    async () => assignment,
  );
  expect(await wrapped.forWorkItem('work-2')).toMatchObject({
    title: 'Real title',
    body: 'Real body',
    assignment,
  });
});

it('leaves ordinary work unchanged', async () => {
  const wrapped = withDelegatedAssignment(reader('T', 'B'), async () => undefined);
  expect(await wrapped.forWorkItem('work-3')).toEqual({ title: 'T', body: 'B', comments: [] });
});
