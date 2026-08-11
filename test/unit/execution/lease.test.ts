import { describe, expect, it } from 'vitest';

import { executionFixture } from './support.js';

describe('Run leases', () => {
  it('records a renewable lease with owner and expiry', async () => {
    const fixture = executionFixture();
    const pending = fixture.start('resident-a');
    const run = await fixture.started();

    await expect(fixture.service.claim(run.runId, 'resident-a')).resolves.toMatchObject({
      lease: {
        owner: 'resident-a',
        acquiredAt: '2026-07-30T12:00:00.000Z',
        expiresAt: '2026-07-30T12:01:00.000Z',
      },
    });
    fixture.clock.advance(30_000);
    await expect(fixture.service.renewLease(run.runId, 'resident-a')).resolves.toMatchObject({
      lease: { expiresAt: '2026-07-30T12:01:30.000Z' },
    });

    fixture.complete({ kind: 'done' });
    await pending;
  });

  it('does not let a second owner execute an unexpired Run', async () => {
    const fixture = executionFixture();
    const pending = fixture.start('resident-a');
    await fixture.started();

    await expect(fixture.start('resident-b')).rejects.toThrow(/lease/i);

    fixture.complete({ kind: 'done' });
    await pending;
  });

  it('does not renew a lease before its configured renewal interval', async () => {
    const fixture = executionFixture();
    const pending = fixture.start('resident-a');
    const run = await fixture.started();

    await expect(fixture.service.renewLease(run.runId, 'resident-a')).rejects.toThrow(/renewal/i);
    fixture.clock.advance(30_000);
    await expect(fixture.service.renewLease(run.runId, 'resident-a')).resolves.toMatchObject({
      lease: { acquiredAt: '2026-07-30T12:00:30.000Z' },
    });

    fixture.complete({ kind: 'done' });
    await pending;
  });
});
