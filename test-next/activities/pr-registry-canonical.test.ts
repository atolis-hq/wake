import { expect, it } from 'vitest';

import {
  ActivityRegistry,
  createPullRequestMergeActivity,
  createPullRequestMergeAuthorityGate,
} from '../../src-next/activities/index.js';
import { TestWorld } from '../e2e/support/world.js';

it('only the canonical merge factory owns the pr.merge Activity registration', () => {
  const world = new TestWorld();
  const registry = new ActivityRegistry();
  const canonical = createPullRequestMergeActivity(world.journal, world.pullRequests);
  const authority = createPullRequestMergeAuthorityGate(world.pullRequests);

  registry.register(canonical);

  expect(registry.get('pr.merge')).toBe(canonical);
  expect(authority).not.toHaveProperty('name');
  expect(authority).not.toHaveProperty('handler');
});
