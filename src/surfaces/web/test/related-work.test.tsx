import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import type { WorkDetailResponse } from '../../api/contracts/work.js';
import { RelatedWork } from '../src/features/work/delegation-sections.js';

type Delegation = NonNullable<WorkDetailResponse['delegation']>;

afterEach(cleanup);

const child = {
  workItemKey: 'wk_child',
  workItemId: 'work-child',
  parentWorkItemKey: 'wk_root',
  objective: 'Add a.txt',
  workflowName: 'child-impl',
  status: 'completed',
  cohortId: 'cohort',
  resources: [],
} as unknown as Delegation['children'][number];

function renderRelated(delegation: Partial<Delegation>, workItemKey: string) {
  render(
    <MemoryRouter>
      <RelatedWork
        delegation={{ rootWorkItemKey: 'wk_root', children: [child], ...delegation } as Delegation}
        workItemKey={workItemKey}
      />
    </MemoryRouter>,
  );
}

it('offers no parent or root links on the delivery root itself', () => {
  renderRelated({}, 'wk_root');
  expect(screen.queryByRole('link', { name: 'View delivery root' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'View parent' })).toBeNull();
  expect(screen.getByRole('link', { name: /Add a\.txt/ })).toBeTruthy();
});

it('does not repeat the root when it is also the parent', () => {
  renderRelated({ parentWorkItemKey: 'wk_root' }, 'wk_child');
  expect(screen.getByRole('link', { name: 'View parent' }).getAttribute('href')).toBe(
    '/work/wk_root',
  );
  expect(screen.queryByRole('link', { name: 'View delivery root' })).toBeNull();
});

it('links to a distinct root and parent for a nested child', () => {
  renderRelated({ parentWorkItemKey: 'wk_mid' }, 'wk_leaf');
  expect(screen.getByRole('link', { name: 'View parent' }).getAttribute('href')).toBe(
    '/work/wk_mid',
  );
  expect(screen.getByRole('link', { name: 'View delivery root' }).getAttribute('href')).toBe(
    '/work/wk_root',
  );
});
