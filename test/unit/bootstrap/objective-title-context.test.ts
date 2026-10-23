import { expect, it } from 'vitest';
import type { AgentContextReader } from '../../../src/activities/index.js';
import { withObjectiveTitle } from '../../../src/bootstrap/objective-title-context.js';

const reader = (title: string, body = ''): AgentContextReader => ({
  async forWorkItem() {
    return { title, body, comments: [] };
  },
});
const work = (objective: string | undefined) => ({
  get: async () => (objective === undefined ? null : { objective }),
});

it('uses the work objective as the title of work with no provider ticket', async () => {
  const wrapped = withObjectiveTitle(reader(''), work('Add a.txt') as never);
  expect(await wrapped.forWorkItem('work-child')).toEqual({
    title: 'Add a.txt',
    body: '',
    comments: [],
  });
});

it('keeps the provider ticket title when there is one', async () => {
  const wrapped = withObjectiveTitle(reader('Issue title', 'Body'), work('Other') as never);
  expect(await wrapped.forWorkItem('work-1')).toMatchObject({ title: 'Issue title', body: 'Body' });
});

it('leaves the context untouched when the work item is unknown', async () => {
  const wrapped = withObjectiveTitle(reader(''), work(undefined) as never);
  expect(await wrapped.forWorkItem('work-gone')).toMatchObject({ title: '' });
});
