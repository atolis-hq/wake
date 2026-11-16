import { expect, it } from 'vitest';
import { PrerequisiteReadiness } from '../../../src/orchestration/application/prerequisite-readiness.js';

it('names an unresolved upstream cohort target', async () => {
  const read = new PrerequisiteReadiness(
    { events: [], instances: [] } as never,
    {} as never,
    {} as never,
    undefined,
  );
  const result = await read.select(
    {
      workItemId: 'consumer',
      prerequisiteWorkItemIds: ['missing-upstream'],
      prerequisites: [
        {
          assignmentId: 'two',
          cohortId: 'original',
          output: 'change',
          condition: 'delivery-ready',
        },
      ],
    } as never,
    new Set(),
  );
  expect(result).toMatchObject({ reason: 'Upstream in another cohort not found: two/change' });
});
