import { z } from 'zod';

import {
  agentActionValues,
  runnerSentinelValues,
  stageValues,
} from './stages.js';

const isoTimestampSchema = z.string().datetime({ offset: true });
const stageSchema = z.enum(stageValues);
export const runnerSentinelSchema = z.enum(runnerSentinelValues);
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
  isBotAuthored: z.boolean().default(false),
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
            expectedEcho: { commentIds: [], labels: [] },
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
    lastRunId: z.string().optional(),
    sessionId: z.string().optional(),
    workspacePath: z.string().optional(),
    blockReason: z.string().optional(),
    syncedAt: isoTimestampSchema,
    stageHistory: z.array(stageHistoryEntrySchema),
    recentEventIds: z.array(z.string()).default([]),
    expectedEcho: z.object({
      commentIds: z.array(z.string()).default([]),
      labels: z.array(z.string()).default([]),
    }).default({ commentIds: [], labels: [] }),
  }),
  context: z.record(z.string(), z.unknown()).default({}),
}));

export const runRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  repo: z.string(),
  issueNumber: z.number().int().positive(),
  action: agentActionSchema,
  status: z.enum(['running', 'completed', 'awaiting-approval', 'blocked', 'failed']),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.optional(),
  sessionId: z.string().optional(),
  sentinel: runnerSentinelSchema.optional(),
  summary: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ledgerSchema = z.object({
  schemaVersion: z.literal(1),
  pausedUntil: isoTimestampSchema.optional(),
});

export const defaultSmokePrompt = 'This is Eddy, reply with "hi Eddy only"';

export const wakeConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  paths: z.object({
    wakeRoot: z.string(),
    promptsRoot: z.string().optional(),
  }),
  sandbox: z.object({
    image: z.string().min(1).default('wake-sandbox'),
    containerName: z.string().min(1).default('wake-sandbox'),
    containerMountPath: z.string().min(1).default('/wake'),
    containerHomeMountPath: z.string().min(1).default('/home/wake'),
    extraMounts: z.array(z.object({
      source: z.string().min(1),
      target: z.string().min(1),
      readOnly: z.boolean().optional(),
    })).default([]),
  }).default({ image: 'wake-sandbox', containerName: 'wake-sandbox', containerMountPath: '/wake', containerHomeMountPath: '/home/wake', extraMounts: [] }),
  dev: z.object({
    repoRoot: z.string().optional(),
  }).default({}),
  scheduler: z.object({
    intervalMs: z.number().int().positive().default(60 * 1000),
  }).default({ intervalMs: 60 * 1000 }),
  runner: z.object({
    mode: z.enum(['fake', 'claude', 'codex']).default('fake'),
    claude: z.object({
      command: z.string().default('claude'),
      model: z.string().default('haiku'),
      smokeModel: z.string().default('haiku'),
      sessionName: z.string().default('Eddy'),
      remoteControlName: z.string().default('Eddy'),
      smokePrompt: z.string().default(defaultSmokePrompt),
      timeoutMs: z.number().int().positive().default(30 * 60 * 1000),
      remoteControl: z.object({
        enabled: z.boolean().default(false),
      }).default({ enabled: false }),
      models: z.object({
        default: z.string().optional(),
        refine: z.string().optional(),
        implement: z.string().optional(),
      }).default({ default: 'haiku', implement: 'claude-sonnet-4-6' }),
    }).default({ command: 'claude', model: 'haiku', smokeModel: 'haiku', sessionName: 'Eddy', remoteControlName: 'Eddy', smokePrompt: defaultSmokePrompt, timeoutMs: 30 * 60 * 1000, remoteControl: { enabled: false }, models: { default: 'haiku', implement: 'claude-sonnet-4-6' } }),
    codex: z.object({
      command: z.string().default('codex'),
      model: z.string().default('gpt-5.5'),
      smokeModel: z.string().default('gpt-5.4-mini'),
      smokePrompt: z.string().default(defaultSmokePrompt),
      timeoutMs: z.number().int().positive().default(30 * 60 * 1000),
      models: z.object({
        default: z.string().optional(),
        refine: z.string().optional(),
        implement: z.string().optional(),
      }).default({ default: 'gpt-5.5', implement: 'gpt-5.5' }),
    }).default({ command: 'codex', model: 'gpt-5.5', smokeModel: 'gpt-5.4-mini', smokePrompt: defaultSmokePrompt, timeoutMs: 30 * 60 * 1000, models: { default: 'gpt-5.5', implement: 'gpt-5.5' } }),
  }).default({ mode: 'fake', claude: { command: 'claude', model: 'haiku', smokeModel: 'haiku', sessionName: 'Eddy', remoteControlName: 'Eddy', smokePrompt: defaultSmokePrompt, timeoutMs: 30 * 60 * 1000, remoteControl: { enabled: false }, models: { default: 'haiku', implement: 'claude-sonnet-4-6' } }, codex: { command: 'codex', model: 'gpt-5.5', smokeModel: 'gpt-5.4-mini', smokePrompt: defaultSmokePrompt, timeoutMs: 30 * 60 * 1000, models: { default: 'gpt-5.5', implement: 'gpt-5.5' } } }),
  sources: z.object({
    github: z.object({
      enabled: z.boolean().default(false),
      repos: z.array(z.string().min(1)).default([]),
      polling: z.object({
        maxIssuesPerRepo: z.number().int().positive().default(25),
        commentPageSize: z.number().int().positive().default(25),
        lookbackMs: z.number().int().nonnegative().default(60_000),
      }).default({ maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 }),
      policy: z.object({
        requiredLabels: z.array(z.string()).default([]),
        ignoredLabels: z.array(z.string()).default([]),
        requiredAssignees: z.array(z.string()).default([]),
      }).default({ requiredLabels: [], ignoredLabels: [], requiredAssignees: [] }),
      publication: z.object({
        postStatusComments: z.boolean().default(true),
        activeLabel: z.string().optional(),
      }).default({ postStatusComments: true }),
    }).default({ enabled: false, repos: [], polling: { maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 }, policy: { requiredLabels: [], ignoredLabels: [], requiredAssignees: [] }, publication: { postStatusComments: true } }),
  }).default({ github: { enabled: false, repos: [], polling: { maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 }, policy: { requiredLabels: [], ignoredLabels: [], requiredAssignees: [] }, publication: { postStatusComments: true } } }),
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
): 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL' {
  const lastLine = result
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);

  const parsed = runnerSentinelSchema.safeParse(lastLine);
  return parsed.success ? parsed.data : 'FAILED';
}
