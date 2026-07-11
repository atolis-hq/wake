import { describe, expect, it, vi } from 'vitest';

const paginateIterator = vi.fn();
const paginate = Object.assign(vi.fn(), { iterator: paginateIterator });

const setLabels = vi.fn();

function pagesOf(...pages: unknown[][]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const data of pages) {
        yield { data };
      }
    },
  };
}

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
    paginateIterator.mockReturnValueOnce(pagesOf([
      { number: 5, title: 'A real issue' },
      { number: 6, title: 'An open PR', pull_request: { url: 'https://example.test/pulls/6' } },
    ]));

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const issues = await client.listIssues(
      'atolis-hq',
      'wake',
      25,
      '2026-07-11T11:00:00.000Z',
    );

    expect(issues).toHaveLength(2);
    expect(issues[0]?.number).toBe(5);
    expect(issues[1]?.number).toBe(6);
    expect(issues[1]).toHaveProperty('pull_request');
    expect(paginateIterator).toHaveBeenCalledWith(expect.anything(), {
      owner: 'atolis-hq',
      repo: 'wake',
      state: 'all',
      per_page: 25,
      since: '2026-07-11T11:00:00.000Z',
    });
  });

  it('stops paginating once maxResults is reached instead of walking every page (E4)', async () => {
    paginateIterator.mockReturnValueOnce(pagesOf(
      [{ number: 1 }, { number: 2 }],
      [{ number: 3 }, { number: 4 }],
      [{ number: 5 }, { number: 6 }],
    ));

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const issues = await client.listIssues('atolis-hq', 'wake', 3);

    expect(issues.map((issue) => (issue as { number: number }).number)).toEqual([1, 2, 3]);
    expect(paginateIterator).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      per_page: 3,
    }));
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
