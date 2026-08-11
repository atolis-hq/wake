import { describe, expect, it } from 'vitest';
import { createWorkId, isWorkId } from '../../src/lib/work-id.js';

describe('createWorkId', () => {
  it('mints ids with the work- prefix and a 26-char ULID', () => {
    expect(createWorkId()).toMatch(/^work-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('mints a distinct id every call', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createWorkId()));
    expect(ids.size).toBe(1000);
  });

  it('mints ids that are safe to use verbatim as a filename', () => {
    // Work ids are used directly as path segments (state/<workId>.json), so
    // they must never require escaping.
    expect(createWorkId()).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('mints ids that sort chronologically as strings', async () => {
    const first = createWorkId();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = createWorkId();
    expect(first < second).toBe(true);
  });
});

describe('isWorkId', () => {
  it('accepts a minted id', () => {
    expect(isWorkId(createWorkId())).toBe(true);
  });

  it.each([
    ['a ticket-shaped key', 'github:atolis-hq/wake#82'],
    ['a bare ulid', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['the prefix alone', 'work-'],
    ['lowercase ulid body', 'work-01arz3ndektsv4rrffq69g5fav'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isWorkId(value)).toBe(false);
  });
});
