import { expect, it, vi } from 'vitest';
import { reportPartialPollFailure } from '../../../../src/integrations/github/infrastructure/poll-watermark.js';

it('names the failure class and status without echoing the message', () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    reportPartialPollFailure(
      'o/r',
      'issue comments #1',
      Object.assign(new Error('token ghp_secret leaked'), { name: 'HttpError', status: 503 }),
    );
    reportPartialPollFailure('o/r', 'issue comments #2');
    const [first, second] = write.mock.calls.map(([chunk]) => String(chunk));
    expect(first).toBe(
      'GitHub poll partial failure for o/r: issue comments #1 (HttpError 503); preserving watermark for replay\n',
    );
    expect(first).not.toContain('secret');
    expect(second).toBe(
      'GitHub poll partial failure for o/r: issue comments #2; preserving watermark for replay\n',
    );
  } finally {
    write.mockRestore();
  }
});
