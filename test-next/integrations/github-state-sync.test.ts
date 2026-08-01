import { expect, it } from 'vitest';
import {
  createGitHubSource,
  gitHubConfigSchema,
  isGitHubWakeEcho,
  reconcileGitHubWakeLabels,
} from '../../src-next/integrations/github/index.js';

it('validates GitHub polling configuration and isolates a failed repository', async () => {
  const config = gitHubConfigSchema.parse({
    enabled: true,
    token: 'token',
    repositories: [
      { owner: 'bad', repo: 'repo' },
      { owner: 'good', repo: 'repo' },
    ],
  });
  const source = createGitHubSource(config, {
    async listIssues(owner) {
      if (owner === 'bad') throw new Error('unavailable');
      return [
        {
          number: 7,
          title: 'issue',
          body: null,
          state: 'open',
          updated_at: '2026-08-01T00:00:00.000Z',
        },
      ];
    },
    async listPullRequests() {
      return [];
    },
    async listCheckRunsForRef() {
      return [];
    },
    async getCombinedStatusForRef() {
      return [];
    },
  });

  await expect(source.poll(new AbortController().signal)).resolves.toHaveLength(1);
  expect(() => gitHubConfigSchema.parse({ enabled: true, token: 'x', repositories: [] })).toThrow();
});

it('replaces only Wake-owned label families while preserving user labels', () => {
  expect(
    reconcileGitHubWakeLabels(
      ['bug', 'team:platform', 'wake:status.working', 'wake:stage.implement'],
      ['wake:status.waiting', 'wake:workflow.default'],
    ),
  ).toEqual(['bug', 'team:platform', 'wake:status.waiting', 'wake:workflow.default']);
});

it('suppresses Wake-authored comments and Wake-owned labels as provider echoes', () => {
  expect(
    isGitHubWakeEcho({
      authorLogin: 'wake-bot',
      authenticatedLogin: 'wake-bot',
      body: 'Status update',
      labels: ['bug'],
    }),
  ).toBe(true);
  expect(
    isGitHubWakeEcho({
      authorLogin: 'maintainer',
      authenticatedLogin: 'wake-bot',
      body: '<!-- wake:agent -->\nDone',
      labels: ['bug'],
    }),
  ).toBe(true);
  expect(
    isGitHubWakeEcho({
      authorLogin: 'maintainer',
      authenticatedLogin: 'wake-bot',
      body: 'Human update',
      labels: ['wake:status.working'],
    }),
  ).toBe(true);
  expect(
    isGitHubWakeEcho({
      authorLogin: 'maintainer',
      authenticatedLogin: 'wake-bot',
      body: 'Human update',
      labels: ['bug'],
    }),
  ).toBe(false);
});
