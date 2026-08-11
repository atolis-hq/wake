import { describe, expect, it } from 'vitest';

import { resolveWakeVersion } from '../src/version.js';

describe('resolveWakeVersion', () => {
  it('uses an exact git tag when HEAD is tagged', () => {
    const version = resolveWakeVersion({
      gitOutput: (args) => (args.includes('--exact-match') ? 'v1.2.3' : ''),
      readTextFile: () => undefined,
      listTextFiles: () => [],
    });

    expect(version).toBe('v1.2.3');
  });

  it('uses the latest reachable tag plus the commit hash for source checkouts between tags', () => {
    const version = resolveWakeVersion({
      gitOutput: (args) => {
        if (args.includes('--exact-match')) {
          return '';
        }
        if (args.includes('--abbrev=0')) {
          return 'v1.2.0';
        }
        if (args.includes('rev-parse')) {
          return 'abc1234';
        }
        return '';
      },
      readTextFile: () => undefined,
      listTextFiles: () => [],
    });

    expect(version).toBe('v1.2.0+gabc1234');
  });

  it('falls back to the commit hash when no tag is reachable', () => {
    const version = resolveWakeVersion({
      gitOutput: (args) => (args.includes('rev-parse') ? 'abc1234' : ''),
      readTextFile: () => undefined,
      listTextFiles: () => [],
    });

    expect(version).toBe('gabc1234');
  });

  it('can resolve an exact tag from git files when spawning git is unavailable', () => {
    const version = resolveWakeVersion({
      gitOutput: () => '',
      readTextFile: (path) => {
        const normalized = path.replaceAll('\\', '/');
        if (normalized.endsWith('/.git/HEAD')) {
          return 'abc1234567890\n';
        }
        if (normalized.endsWith('/.git/refs/tags/v1.2.3')) {
          return 'abc1234567890\n';
        }
        return undefined;
      },
      listTextFiles: (path) =>
        path.replaceAll('\\', '/').endsWith('/.git/refs/tags')
          ? [{ path: `${path}/v1.2.3`, content: 'abc1234567890\n' }]
          : [],
    });

    expect(version).toBe('v1.2.3');
  });
});
