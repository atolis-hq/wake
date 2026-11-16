import { expect, it } from 'vitest';
import { PrerequisiteReadiness } from '../../../src/orchestration/application/prerequisite-readiness.js';

it.each([undefined, 'original'])(
  'names an unresolved upstream target (cohort: %s)',
  async (cohortId) => {
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
            cohortId,
            output: 'change',
            condition: 'delivery-ready',
          },
        ],
      } as never,
      new Set(),
    );
    expect(result).toMatchObject({ reason: 'Upstream prerequisite not found: two/change' });
  },
);
