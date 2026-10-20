import { expect, it } from 'vitest';
import { checkoutRevision } from '../../../src/integrations/github/infrastructure/checkout-revision.js';

const revision = 'a'.repeat(40);
const checkout = `2026-10-20T00:00:00Z ##[group]Run actions/checkout@v7
2026-10-20T00:00:00Z ##[endgroup]
2026-10-20T00:00:01Z [command]/usr/bin/git log -1 --format=%H
2026-10-20T00:00:01Z ${revision}`;
it('reads the full checkout Git result from ordinary Actions logs', () => {
  expect(checkoutRevision(checkout)).toBe(revision);
});
it.each([
  '',
  revision,
  checkout.replace('actions/checkout', 'other/action'),
  checkout + '\n' + checkout,
])('rejects missing or ambiguous checkout evidence: %#', (log) => {
  expect(checkoutRevision(log)).toBeUndefined();
});
it('does not read a later user step as checkout provenance', () => {
  expect(
    checkoutRevision(
      checkout.replace(revision, '') +
        `
2026-10-20T00:00:02Z ##[group]Run echo fabricated-checkout
2026-10-20T00:00:03Z [command]/usr/bin/git log -1 --format=%H
2026-10-20T00:00:03Z ${revision}`,
    ),
  ).toBeUndefined();
});
