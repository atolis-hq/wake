import { describe, expect, it } from 'vitest';

import { scrubSecrets } from '../../src/cli/sandbox-exec-logging.js';

describe('scrubSecrets', () => {
  it('redacts TOKEN/SECRET/PASSWORD/KEY-suffixed env assignments', () => {
    expect(scrubSecrets('GITHUB_TOKEN=abc123')).toBe('GITHUB_TOKEN=[REDACTED]');
    expect(scrubSecrets('MY_SECRET_VALUE=xyz')).toBe('MY_SECRET_VALUE=[REDACTED]');
    expect(scrubSecrets('DB_PASSWORD=hunter2')).toBe('DB_PASSWORD=[REDACTED]');
    expect(scrubSecrets('API_KEY=zzz')).toBe('API_KEY=[REDACTED]');
  });

  it('redacts GitHub token prefixes anywhere in a line', () => {
    expect(scrubSecrets('using token ghp_abcdefghijklmnop')).toBe('using token [REDACTED]');
    expect(scrubSecrets('gho_1234567890abcdef in header')).toBe('[REDACTED] in header');
    expect(scrubSecrets('github_pat_ABC123 present')).toBe('[REDACTED] present');
  });

  it('leaves lines with no secrets unchanged', () => {
    expect(scrubSecrets('hello world')).toBe('hello world');
  });
});
