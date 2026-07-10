import { describe, expect, it, vi } from 'vitest';

const paginate = vi.fn();

const setLabels = vi.fn();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    paginate,
    rest: {
      issues: {
        listForRepo: vi.fn(),
        listComments: vi.fn(),
        createComment: vi.fn(),
        setLabels,
      },
    },
  })),
}));

describe('github client', () => {
  it('passes through GitHub issues API results, including pull requests', async () => {
    paginate.mockResolvedValueOnce([
      { number: 5, title: 'A real issue' },
      { number: 6, title: 'An open PR', pull_request: { url: 'https://example.test/pulls/6' } },
    ]);

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const issues = await client.listIssues('atolis-hq', 'wake', 25);

    expect(issues).toHaveLength(2);
    expect(issues[0]?.number).toBe(5);
    expect(issues[1]?.number).toBe(6);
    expect(issues[1]).toHaveProperty('pull_request');
  });

  it('replaces issue labels via the dedicated setLabels endpoint', async () => {
    setLabels.mockResolvedValueOnce({ data: [] });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    await client.setLabels('atolis-hq', 'wake', 74, [
      'bug',
      'wake:status.working',
      'wake:stage.active',
    ]);

    expect(setLabels).toHaveBeenCalledOnce();
    expect(setLabels).toHaveBeenCalledWith({
      owner: 'atolis-hq',
      repo: 'wake',
      issue_number: 74,
      labels: ['bug', 'wake:status.working', 'wake:stage.active'],
    });
  });
});
