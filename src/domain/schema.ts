import { z } from 'zod';

import {
  agentActionValues,
  runnerSentinelValues,
  stageValues,
} from './stages.js';

export const wakeCommentMarker = '<!-- wake -->';

const isoTimestampSchema = z.string().datetime({ offset: true });
const stageSchema = z.enum(stageValues);
const runnerSentinelSchema = z.enum(runnerSentinelValues);
const agentActionSchema = z.enum(agentActionValues);

const stageHistoryEntrySchema = z.object({
  stage: stageSchema,
  changedAt: isoTimestampSchema,
  reason: z.string(),
});

const commentSnapshotSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.object({
    login: z.string(),
  }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  isWakeAuthored: z.boolean(),
});

const issueSnapshotSchema = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  state: z.enum(['open', 'closed']),
  url: z.string().url(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const sourceStateRecordSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string(),
  key: z.string(),
  lastSuccessfulPollAt: isoTimestampSchema,
});

const eventEnvelopeSourceRefsSchema = z.object({
  repo: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
  commentId: z.string().optional(),
  reviewId: z.string().optional(),
  runId: z.string().optional(),
  sink: z.string().optional(),
  sourceUrl: z.string().optional(),
});

export const eventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string(),
  workItemKey: z.string(),
  streamScope: z.enum(['global-intake', 'work-item']),
  direction: z.enum(['inbound', 'outbound', 'internal']),
  sourceSystem: z.string(),
  sourceEventType: z.string(),
  sourceRefs: eventEnvelopeSourceRefsSchema,
  occurredAt: isoTimestampSchema,
  ingestedAt: isoTimestampSchema,
  trigger: z.enum(['immediate', 'context-only']),
  payload: z.record(z.string(), z.unknown()),
  raw: z.record(z.string(), z.unknown()).optional(),
  derivedHints: z.record(z.string(), z.unknown()).optional(),
});

export const issueStateRecordSchema = z.preprocess((input) => {
  if (input === null || typeof input !== 'object') {
    return input;
  }

  const record = input as Record<string, unknown>;
  const issue = record.issue as
    | { repo?: unknown; number?: unknown }
    | undefined;
  const workItemKey =
    record.workItemKey ??
    (issue !== undefined &&
    typeof issue.repo === 'string' &&
    typeof issue.number === 'number'
      ? `${issue.repo}#${issue.number}`
      : undefined);

  return {
    comments: [],
    context: {},
    ...record,
    workItemKey,
    wake:
      record.wake !== null && typeof record.wake === 'object'
        ? {
            recentEventIds: [],
            ...(record.wake as Record<string, unknown>),
          }
        : record.wake,
  };
}, z.object({
  schemaVersion: z.literal(1),
  workItemKey: z.string(),
  issue: issueSnapshotSchema,
  comments: z.array(commentSnapshotSchema).default([]),
  latestComment: commentSnapshotSchema.optional(),
  wake: z.object({
    stage: stageSchema,
    attempts: z.number().int().nonnegative(),
    lastRunId: z.string().optional(),
    sessionId: z.string().optional(),
    workspacePath: z.string().optional(),
    blockReason: z.string().optional(),
    syncedAt: isoTimestampSchema,
    stageHistory: z.array(stageHistoryEntrySchema),
    recentEventIds: z.array(z.string()).default([]),
  }),
  context: z.record(z.string(), z.unknown()).default({}),
}));

export const runRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  repo: z.string(),
  issueNumber: z.number().int().positive(),
  action: agentActionSchema,
  status: z.enum(['running', 'completed', 'blocked', 'failed']),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.optional(),
  sessionId: z.string().optional(),
  sentinel: runnerSentinelSchema.optional(),
  summary: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const eventRecordSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.string(),
  occurredAt: isoTimestampSchema,
  repo: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
  runId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const ledgerSchema = z.object({
  schemaVersion: z.literal(1),
  pausedUntil: isoTimestampSchema.optional(),
});

export const wakeConfigSchema = z.object({
  schemaVersion: z.literal(1),
  paths: z.object({
    wakeRoot: z.string(),
    promptsRoot: z.string().optional(),
  }),
  sandbox: z.object({
    image: z.string().min(1),
    containerName: z.string().min(1),
    containerMountPath: z.string().min(1),
    containerHomeMountPath: z.string().min(1),
  }),
  scheduler: z.object({
    intervalMs: z.number().int().positive(),
  }),
  runner: z.object({
    mode: z.enum(['fake', 'claude']),
    claude: z.object({
      command: z.string(),
      model: z.string(),
      smokeModel: z.string(),
      sessionName: z.string(),
      remoteControlName: z.string(),
      smokePrompt: z.string(),
      remoteControl: z.object({
        enabled: z.boolean(),
      }),
    }),
  }),
  sources: z.object({
    github: z.object({
      enabled: z.boolean(),
      repos: z.array(z.string().min(1)),
      polling: z.object({
        maxIssuesPerRepo: z.number().int().positive(),
        commentPageSize: z.number().int().positive(),
        lookbackMs: z.number().int().nonnegative(),
      }),
      policy: z.object({
        requiredLabels: z.array(z.string()),
        ignoredLabels: z.array(z.string()),
      }),
      publication: z.object({
        postStatusComments: z.boolean(),
        activeLabel: z.string().optional(),
      }),
    }),
  }),
});

export const claudePrintResultSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  result: z.string(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export function parseIssueStateRecord(input: unknown) {
  return issueStateRecordSchema.parse(input);
}

export function parseRunRecord(input: unknown) {
  return runRecordSchema.parse(input);
}

export function parseEventRecord(input: unknown) {
  return eventRecordSchema.parse(input);
}

export function parseEventEnvelope(input: unknown) {
  return eventEnvelopeSchema.parse(input);
}

export function parseLedger(input: unknown) {
  return ledgerSchema.parse(input);
}

export function parseWakeConfig(input: unknown) {
  return wakeConfigSchema.parse(input);
}

export function parseSourceStateRecord(input: unknown) {
  return sourceStateRecordSchema.parse(input);
}

export function parseClaudePrintResult(input: unknown) {
  return claudePrintResultSchema.parse(input);
}

export function parseRunnerResultSentinel(
  result: string,
): 'DONE' | 'BLOCKED' | 'FAILED' {
  const matches = Array.from(
    result.matchAll(/\b(DONE|BLOCKED|FAILED)\b/g),
    (match) => match[1],
  );

  const lastMatch = matches.at(-1);
  return lastMatch === undefined ? 'FAILED' : runnerSentinelSchema.parse(lastMatch);
}

export function isWakeAuthoredComment(body: string): boolean {
  return body.includes(wakeCommentMarker);
}
