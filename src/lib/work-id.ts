import { ulid } from 'ulid';

/** Crockford base32 alphabet, as used by ULID: no I, L, O, or U. */
const WORK_ID_PATTERN = /^work-[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Mints a provider-independent work item identifier.
 *
 * Work ids name the work, never any surface that represents it: a ticket key
 * is not a stable name for work (issue transfer renumbers it, and work can
 * split or merge). See docs/superpowers/specs/2026-07-16-work-identity-correlation-design.md (D3).
 *
 * ULIDs sort chronologically as strings, so state/ listings are naturally
 * ordered by mint time, and are filename-safe with no escaping.
 */
export function createWorkId(): string {
  return `work-${ulid()}`;
}

export function isWorkId(value: string): boolean {
  return WORK_ID_PATTERN.test(value);
}
