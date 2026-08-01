import { describe, expect, it } from 'vitest';
import { UlidIdGenerator } from '../../src-next/kernel/index.js';
import { resourceId } from '../../src-next/resources/index.js';
import { workItemId } from '../../src-next/work/index.js';

describe('minted identity brands', () => {
  const ids = new UlidIdGenerator();

  it('accepts a minted WorkItem identity', () =>
    expect(workItemId(ids.next('work'))).toMatch(/^work-/));
  it('accepts a minted Resource identity', () =>
    expect(resourceId(ids.next('resource'))).toMatch(/^resource-/));
  it('rejects a provider-derived WorkItem identity', () =>
    expect(() => workItemId('work-github-owner-repo-7')).toThrow(/Invalid WorkItemId/));
  it('rejects a provider-derived Resource identity', () =>
    expect(() => resourceId('resource-github-owner-repo-7')).toThrow(/Invalid ResourceId/));
  it('rejects a schedule-derived WorkItem identity', () =>
    expect(() => workItemId('work-nightly-triage-2026-08-01t02-00-00-000z')).toThrow(
      /Invalid WorkItemId/,
    ));
  it('rejects a readable identity that is not a minted ULID', () =>
    expect(() => workItemId('work-config')).toThrow(/Invalid WorkItemId/));
});
