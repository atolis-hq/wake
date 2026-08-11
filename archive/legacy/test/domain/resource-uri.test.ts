import { describe, expect, it } from 'vitest';
import {
  buildResourceUri,
  correlationProvenanceSchema,
  correlationRelationSchema,
  correlationRoleSchema,
  resourceUriSchema,
} from '../../src/domain/resource-uri.js';

describe('resourceUriSchema', () => {
  it.each([
    ['a github issue', 'github:issue:atolis-hq/wake#82'],
    ['a github pr', 'github:pr:atolis-hq/wake#91'],
    ['a review thread', 'github:pr-review-thread:atolis-hq/wake#91/rt_123'],
    ['a slack thread', 'slack:thread:C0123/1699999999.000042'],
    ['a jira issue', 'jira:issue:WAKE-12'],
    ['a gitlab mr, with provider-native kind', 'gitlab:mr:team/repo!7'],
  ])('accepts %s', (_label, uri) => {
    expect(resourceUriSchema.parse(uri)).toBe(uri);
  });

  it.each([
    ['no kind or locator', 'github'],
    ['no locator', 'github:issue'],
    ['an empty locator', 'github:issue:'],
    ['an empty provider', ':issue:atolis-hq/wake#82'],
    ['an uppercase provider', 'GitHub:issue:atolis-hq/wake#82'],
    ['empty', ''],
  ])('rejects %s', (_label, uri) => {
    expect(() => resourceUriSchema.parse(uri)).toThrow();
  });

  it('keeps a locator containing colons intact', () => {
    // Only provider and kind are delimited; everything after the second colon
    // is opaque locator and must survive validation untouched.
    const uri = 'slack:thread:C0123/1699999999.000042:extra:segments';
    expect(resourceUriSchema.parse(uri)).toBe(uri);
  });
});

describe('buildResourceUri', () => {
  it('joins the three segments', () => {
    expect(buildResourceUri('github', 'issue', 'atolis-hq/wake#82')).toBe(
      'github:issue:atolis-hq/wake#82',
    );
  });

  it('rejects a locator that would produce an invalid uri', () => {
    expect(() => buildResourceUri('github', 'issue', '')).toThrow();
  });
});

describe('correlation vocabularies', () => {
  it('accepts every role, and nothing else', () => {
    for (const role of [
      'representation',
      'implementation',
      'discussion',
      'review',
      'documentation',
      'decision',
    ]) {
      expect(correlationRoleSchema.parse(role)).toBe(role);
    }
    // Roles are Wake-owned relationship vocabulary, never provider terms:
    // github:pr: and gitlab:mr: both register as `implementation`.
    expect(() => correlationRoleSchema.parse('pr')).toThrow();
    expect(() => correlationRoleSchema.parse('mr')).toThrow();
  });

  it('accepts both relations, and nothing else', () => {
    expect(correlationRelationSchema.parse('primary')).toBe('primary');
    expect(correlationRelationSchema.parse('secondary')).toBe('secondary');
    expect(() => correlationRelationSchema.parse('tertiary')).toThrow();
  });

  it('accepts every provenance, and nothing else', () => {
    for (const provenance of ['wake-created', 'agent-reported', 'detected', 'operator-declared']) {
      expect(correlationProvenanceSchema.parse(provenance)).toBe(provenance);
    }
    expect(() => correlationProvenanceSchema.parse('guessed')).toThrow();
  });
});
