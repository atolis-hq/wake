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

export const issueStateRecordSchema = z.object({
  schemaVersion: z.literal(1),
  issue: z.object({
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
  }),
  comments: z.array(commentSnapshotSchema),
  wake: z.object({
    stage: stageSchema,
    attempts: z.number().int().nonnegative(),
    lastRunId: z.string().optional(),
    sessionId: z.string().optional(),
    workspacePath: z.string().optional(),
    blockReason: z.string().optional(),
    syncedAt: isoTimestampSchema,
    stageHistory: z.array(stageHistoryEntrySchema),
  }),
  context: z.record(z.string(), z.unknown()).default({}),
});

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

export function parseLedger(input: unknown) {
  return ledgerSchema.parse(input);
}

export function parseWakeConfig(input: unknown) {
  return wakeConfigSchema.parse(input);
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
