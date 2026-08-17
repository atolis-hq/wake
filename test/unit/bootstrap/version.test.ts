import { describe, expect, it } from 'vitest';

import { resolveWakeVersion } from '../../../src/bootstrap/version.js';

describe('target Wake version resolution', () => {
  it('uses an exact git tag at HEAD', () => {
    expect(
      resolveWakeVersion({
        gitOutput: (arguments_) => (arguments_.includes('--exact-match') ? 'v1.2.3' : ''),
      }),
    ).toBe('v1.2.3');
  });

  it('formats a source checkout between tags as latest tag plus short git hash', () => {
    expect(
      resolveWakeVersion({
        gitOutput: (arguments_) => {
          if (arguments_.includes('--abbrev=0')) return 'v1.2.0';
          if (arguments_.includes('rev-parse')) return 'abc1234';
          return '';
        },
        readTextFile: () => undefined,
        listTextFiles: () => [],
      }),
    ).toBe('v1.2.0+gabc1234');
  });

  it('formats an untagged source checkout using its short git hash', () => {
    expect(
      resolveWakeVersion({
        gitOutput: (arguments_) => (arguments_.includes('rev-parse') ? 'abc1234' : ''),
        readTextFile: () => undefined,
        listTextFiles: () => [],
      }),
    ).toBe('gabc1234');
  });

  it('resolves an exact tag from git files when spawning git is unavailable', () => {
    expect(
      resolveWakeVersion({
        gitOutput: () => '',
        readTextFile: (path) => {
          const normalized = path.replaceAll('\\', '/');
          if (normalized.endsWith('/.git/HEAD')) return 'abc1234567890\n';
          if (normalized.endsWith('/.git/refs/tags/v1.2.3')) return 'abc1234567890\n';
          return undefined;
        },
        listTextFiles: (path) =>
          path.replaceAll('\\', '/').endsWith('/.git/refs/tags')
            ? [{ path: `${path}/v1.2.3`, content: 'abc1234567890\n' }]
            : [],
      }),
    ).toBe('v1.2.3');
  });

  it('resolves an annotated exact tag from packed refs when spawning git is unavailable', () => {
    expect(
      resolveWakeVersion({
        gitOutput: () => '',
        readTextFile: (path) => {
          const normalized = path.replaceAll('\\', '/');
          if (normalized.endsWith('/.git/HEAD')) return 'abc1234567890\n';
          if (normalized.endsWith('/.git/packed-refs')) {
            return '# pack-refs with: peeled fully-peeled\nfeedface refs/tags/v1.2.3\n^abc1234567890\n';
          }
          return undefined;
        },
        listTextFiles: () => [],
      }),
    ).toBe('v1.2.3');
  });

  it('formats a git-file-only untagged source checkout using its abbreviated HEAD hash', () => {
    expect(
      resolveWakeVersion({
        gitOutput: () => '',
        readTextFile: (path) =>
          path.replaceAll('\\', '/').endsWith('/.git/HEAD') ? 'abc1234567890\n' : undefined,
        listTextFiles: () => [],
      }),
    ).toBe('gabc1234');
  });

  it('uses the stable development placeholder when no source identity is available', () => {
    expect(
      resolveWakeVersion({
        gitOutput: () => '',
        readTextFile: () => undefined,
        listTextFiles: () => [],
      }),
    ).toBe('0.1.0-dev');
  });
});
