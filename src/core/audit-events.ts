import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AUTONOMOUS_DECISION_AUDIT_EVENT } from '../domain/schema.js';
import type { EventEnvelope, WakeConfig, WorkflowDefinition } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';

type AuditDecisionType =
  | 'trigger.fired'
  | 'watcher.dispatched'
  | 'review.verdict'
  | 'approval.auto-resolved'
  | 'dispatch.rate-limited';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

async function promptRevisionInput(input: {
  config: WakeConfig;
  action?: string;
}): Promise<Record<string, unknown>> {
  if (input.action === undefined) {
    return {};
  }

  const promptsRoot = input.config.paths.promptsRoot;
  if (promptsRoot === undefined) {
    return { prompt: { action: input.action, status: 'not-configured' } };
  }

  for (const suffix of ['.md', '.start.md', '.resume.md']) {
    const path = join(promptsRoot, `${input.action}${suffix}`);
    try {
      return {
        prompt: {
          action: input.action,
          path,
          sha256: createHash('sha256')
            .update(await readFile(path, 'utf8'))
            .digest('hex'),
        },
      };
    } catch {
      // Try the next supported prompt template name.
    }
  }

  return { prompt: { action: input.action, status: 'missing' } };
}

export async function workflowRevision(input: {
  config: WakeConfig;
  workflowName: string;
  workflow: WorkflowDefinition;
  action?: string;
}): Promise<string> {
  const revisionInput = {
    workflowName: input.workflowName,
    workflow: input.workflow,
    ...(await promptRevisionInput({
      config: input.config,
      ...(input.action === undefined ? {} : { action: input.action }),
    })),
  };
  return `sha256:${createHash('sha256').update(stableJson(revisionInput)).digest('hex')}`;
}

export function createAutonomousDecisionAuditEvent(input: {
  eventId: string;
  decisionType: AuditDecisionType;
  workItemKey: string;
  runId: string;
  workflowRevision: string;
  inputsConsidered: Record<string, unknown>;
  outcome: Record<string, unknown>;
  timestamp: string;
  sourceRefs?: EventEnvelope['sourceRefs'];
}): EventEnvelope {
  return createEventEnvelope({
    eventId: input.eventId,
    workItemKey: input.workItemKey,
    streamScope: 'work-item',
    direction: 'internal',
    sourceSystem: 'wake',
    sourceEventType: AUTONOMOUS_DECISION_AUDIT_EVENT,
    sourceRefs: {
      ...(input.sourceRefs ?? {}),
      runId: input.runId,
    },
    occurredAt: input.timestamp,
    ingestedAt: input.timestamp,
    trigger: 'context-only',
    payload: {
      decisionType: input.decisionType,
      workItemId: input.workItemKey,
      runId: input.runId,
      workflowRevision: input.workflowRevision,
      inputsConsidered: input.inputsConsidered,
      outcome: input.outcome,
      timestamp: input.timestamp,
    },
  });
}
