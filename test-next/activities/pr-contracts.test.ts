import { expect, expectTypeOf, it } from 'vitest';

import {
  createPullRequestMergeActivity,
  type PullRequestMergeInput,
} from '../../src-next/activities/index.js';
import { resourceId } from '../../src-next/resources/index.js';
import { TestWorld } from '../e2e/support/world.js';

it('pr.merge defaults only target and keeps nested and top-level schemas strict', () => {
  const world = new TestWorld();
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);
  expect(activity.inputSchema.parse({ method: 'rebase', requireChecks: false })).toEqual({
    target: 'primary',
    method: 'rebase',
    requireChecks: false,
  });
  expect(() =>
    activity.inputSchema.parse({
      target: { resourceId: 'resource-1', extra: true },
      method: 'merge',
      requireChecks: true,
    }),
  ).toThrow();
});

it('exports the exact shared parsed merge input contract', () => {
  expectTypeOf<PullRequestMergeInput>().toEqualTypeOf<{
    readonly target: 'primary' | { readonly resourceId: ReturnType<typeof resourceId> };
    readonly method: 'merge' | 'squash' | 'rebase';
    readonly requireChecks: boolean;
  }>();
});
