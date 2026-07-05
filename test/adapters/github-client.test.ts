import { describe, expect, it, vi } from 'vitest';

const paginate = vi.fn();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    paginate,
    rest: {
      issues: {
        listForRepo: vi.fn(),
        listComments: vi.fn(),
        createComment: vi.fn(),
      },
    },
  })),
}));

describe('github client', () => {
  it('filters out pull requests from listIssues results', async () => {
    paginate.mockResolvedValueOnce([
      { number: 5, title: 'A real issue' },
      { number: 6, title: 'An open PR', pull_request: { url: 'https://example.test/pulls/6' } },
    ]);

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const issues = await client.listIssues('atolis-hq', 'wake', 25);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(5);
  });
});
