import { describe, expect, it } from 'vitest';
import { resourceCapability, resourceKind } from '../../../src/resources/index.js';
import { presentResource } from '../../../src/surfaces/api/presenters/resources.js';
import { resId } from '../../support/identities.js';

const noLink = () => null;
const githubLink = () => 'https://github.com/atolis-hq/wake/issues/412';

describe('presentResource', () => {
  it('uses the resolved title when present, and includes the external link when the resolver matches', () => {
    const present = presentResource(githubLink);
    expect(
      present({
        resourceId: resId('one'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake#412' },
        capabilities: [resourceCapability('commentable')],
        title: 'Fix flaky checkout test',
      }),
    ).toEqual({
      resourceId: resId('one'),
      adapter: 'github',
      kind: resourceKind('issue'),
      title: 'Fix flaky checkout test',
      locatorLabel: 'issue atolis-hq/wake#412',
      externalUrl: 'https://github.com/atolis-hq/wake/issues/412',
      capabilities: [resourceCapability('commentable')],
    });
  });

  it('falls back to a locator label and omits externalUrl when no resolver matches', () => {
    const present = presentResource(noLink);
    expect(
      present({
        resourceId: resId('two'),
        kind: resourceKind('document'),
        externalKey: { adapter: 'unknown-adapter', key: 'design-notes.md' },
        capabilities: [],
      }),
    ).toEqual({
      resourceId: resId('two'),
      adapter: 'unknown-adapter',
      kind: resourceKind('document'),
      locatorLabel: 'document design-notes.md',
      capabilities: [],
    });
  });
});
