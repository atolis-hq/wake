import type { EventEnvelope } from '../../kernel/index.js';
import type { LinkWorkItems } from './commands.js';
import type { WorkItemId } from './identifiers.js';

export type WorkEvent =
  | EventEnvelope<'work.item-created', { objective: string }>
  | EventEnvelope<'work.objective-revised', { objective: string }>
  | EventEnvelope<'work.item-linked', { to: WorkItemId; relation: LinkWorkItems['relation'] }>
  | EventEnvelope<'work.item-closed', { reason: string }>
  | EventEnvelope<'work.item-cancelled', { reason: string }>;
