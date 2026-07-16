import { z } from 'zod';

/**
 * Resource URI grammar: `<provider>:<kind>:<locator>`.
 *
 * `provider` matches the adapter's registered source/sink name; `kind` uses
 * the provider's native vocabulary (`github:pr:…` but `gitlab:mr:…`). The
 * locator grammar is provider-specific and opaque to core — everything after
 * the second colon is matched as a single blob and never inspected here.
 * Core compares URIs for equality only (ADR 0001 §1).
 */
const RESOURCE_URI_PATTERN = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*:.+$/;

export const resourceUriSchema = z
  .string()
  .regex(RESOURCE_URI_PATTERN, 'must match <provider>:<kind>:<locator>');

export function buildResourceUri(provider: string, kind: string, locator: string): string {
  return resourceUriSchema.parse(`${provider}:${kind}:${locator}`);
}

/**
 * Wake-owned relationship vocabulary — the graph edge type, deliberately
 * independent of the URI's provider-native `kind`. A new provider adds URI
 * kinds, never new roles; a new role is a Wake modelling decision.
 */
export const correlationRoleSchema = z.enum([
  'representation',
  'implementation',
  'discussion',
  'review',
  'documentation',
  'decision',
]);
export type CorrelationRole = z.infer<typeof correlationRoleSchema>;

/** Exactly one work item may hold `primary` per resource URI (ADR 0001 §2). */
export const correlationRelationSchema = z.enum(['primary', 'secondary']);
export type CorrelationRelation = z.infer<typeof correlationRelationSchema>;

export const correlationProvenanceSchema = z.enum([
  'wake-created',
  'agent-reported',
  'detected',
  'operator-declared',
]);
export type CorrelationProvenance = z.infer<typeof correlationProvenanceSchema>;
