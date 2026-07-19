import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { runnerSentinelValues } from './stages.js';
import {
  correlationProvenanceSchema,
  correlationRelationSchema,
  correlationRoleSchema,
  resourceUriSchema,
} from './resource-uri.js';

const isoTimestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().min(1);

export const reportedArtifactSchema = z.object({
  kind: z.literal('pr'),
  url: z.string().url(),
});

export const wakeArtifactsEnvelopeSchema = z.object({
  artifacts: z.array(reportedArtifactSchema).default([]),
});
export const runnerSentinelSchema = z.enum(runnerSentinelValues);

export const defaultAgentIdentity = 'Wake';
export const defaultSmokePrompt = `This is ${defaultAgentIdentity}, reply with "hi ${defaultAgentIdentity} only"`;

const modelOverridesSchema = z
  .object({
    default: z.string().optional(),
  })
  .catchall(z.string())
  .default({});

const claudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const codexReasoningEffortSchema = z.enum(['low', 'medium', 'high']);
const cursorModeSchema = z.enum(['ask', 'agent']);

const claudeRunnerSettingsSchema = z.object({
  command: z.string().default('claude'),
  model: z.string().default('haiku'),
  smokeModel: z.string().default('haiku'),
  sessionName: z.string().default(defaultAgentIdentity),
  remoteControlName: z.string().default(defaultAgentIdentity),
  smokePrompt: z.string().default(defaultSmokePrompt),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  remoteControl: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  models: modelOverridesSchema.default({ default: 'haiku', implement: 'claude-sonnet-4-6' }),
  effort: claudeEffortSchema.optional(),
});

const codexRunnerSettingsSchema = z.object({
  command: z.string().default('codex'),
  model: z.string().default('gpt-5.5'),
  smokeModel: z.string().default('gpt-5.4-mini'),
  smokePrompt: z.string().default(defaultSmokePrompt),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  models: modelOverridesSchema.default({ default: 'gpt-5.5', implement: 'gpt-5.5' }),
  reasoningEffort: codexReasoningEffortSchema.optional(),
});

const fakeRunnerEntrySchema = z.object({
  kind: z.literal('fake'),
  cli: z.string().default('Fake'),
});

const claudeRunnerEntrySchema = claudeRunnerSettingsSchema.extend({
  kind: z.literal('claude'),
});

const codexRunnerEntrySchema = codexRunnerSettingsSchema.extend({
  kind: z.literal('codex'),
});

const cursorRunnerSettingsSchema = z.object({
  command: z.string().default('cursor'),
  model: z.string().default('composer-2.5'),
  smokeModel: z.string().default('auto'),
  smokePrompt: z.string().default(defaultSmokePrompt),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  models: modelOverridesSchema.default({ default: 'composer-2.5', implement: 'composer-2.5' }),
  defaultMode: cursorModeSchema.optional(),
});

const cursorRunnerEntrySchema = cursorRunnerSettingsSchema.extend({
  kind: z.literal('cursor'),
});

const runnerEntrySchema = z.discriminatedUnion('kind', [
  fakeRunnerEntrySchema,
  claudeRunnerEntrySchema,
  codexRunnerEntrySchema,
  cursorRunnerEntrySchema,
]);

const stageRouteSchema = z.object({
  action: identifierSchema.optional(),
  tier: z.string().optional(),
  runner: z.string().optional(),
});

const runnerRoutingSchema = z.object({
  runnerName: z.string(),
  runnerKind: z.enum(['fake', 'claude', 'codex', 'cursor']),
  tier: z.string().optional(),
  reason: z.string(),
});

const sinkEntrySchema = z
  .object({
    kind: z.string().min(1),
    subscribe: z.array(z.string().min(1)).default([]),
  })
  .passthrough();

export const wakeResultEnvelopeSchema = z.object({
  status: runnerSentinelSchema,
});

const stageHistoryEntrySchema = z.object({
  stage: identifierSchema,
  changedAt: isoTimestampSchema,
  reason: z.string(),
});

const reviewThreadAnchorSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
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
  // Which correlated surface this comment came from; absent = the originating
  // issue thread, keeping every pre-existing comment valid under this schema.
  resourceUri: resourceUriSchema.optional(),
  reviewThread: reviewThreadAnchorSchema.optional(),
});

const issueSnapshotSchema = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  isPullRequest: z.boolean().default(false),
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

export const eventEnvelopeSourceRefsSchema = z.object({
  repo: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
  commentId: z.string().optional(),
  reviewId: z.string().optional(),
  runId: z.string().optional(),
  sink: z.string().optional(),
  sourceUrl: z.string().optional(),
  // Per-event provenance: which external resource this one event came from.
  // Item-level ownership lives only in the correlation registry, never here.
  resourceUri: resourceUriSchema.optional(),
  // An adapter-supplied hint: the resourceUri of the resource this one
  // "belongs to" for correlation purposes (e.g. a PR review-thread comment's
  // parent PR). Opaque to core — never parsed, only used as a fallback key
  // for resourceIndex.resolve() when resourceUri itself misses the index.
  // The adapter that emits an event is the only party allowed to know its
  // own locator grammar; this keeps that knowledge out of core/.
  parentResourceUri: resourceUriSchema.optional(),
});

/** Event type constants for the correlation registry (ADR 0001 §5). */
export const WORK_ITEM_CREATED_EVENT = 'wake.workitem.created';
export const CORRELATION_REGISTERED_EVENT = 'wake.correlation.registered';
export const CORRELATION_RETRACTED_EVENT = 'wake.correlation.retracted';
export const CORRELATION_PRIMARY_CONFLICT_EVENT = 'wake.correlation.primary-conflict';

/**
 * Shared key for events whose resource failed mint qualification (spec D1').
 * Never a real work item: `readIssueState(UNRESOLVED_WORK_ITEM_KEY)` always
 * returns null, so these events are durable and inspectable via the event
 * log but must never materialize a projection or an index entry. Exported
 * from here (rather than only living in tick-runner.ts, which mints these
 * events) so projection-updater.ts's fold can also recognize and skip it —
 * an unqualified event's sourceEventType is still `ticket.upsert` /
 * `fake.issue.upsert` / etc., which the fold would otherwise happily turn
 * into a projection the first time it sees this key with no current record.
 */
export const UNRESOLVED_WORK_ITEM_KEY = 'unresolved';

// The envelope's `workItemKey` already carries the identity; this payload is
// deliberately empty.
export const workItemCreatedPayloadSchema = z.object({});

export const correlationRegisteredPayloadSchema = z.object({
  resourceUri: resourceUriSchema,
  role: correlationRoleSchema,
  relation: correlationRelationSchema,
  provenance: correlationProvenanceSchema,
  registeredBy: z.string().optional(),
});

export const correlationRetractedPayloadSchema = z.object({
  resourceUri: resourceUriSchema,
});

// Warning event emitted when a second `primary` registration lands on an
// already-claimed URI (ADR 0001 §6). Fold behavior lives in the projection.
export const correlationPrimaryConflictPayloadSchema = z.object({
  resourceUri: resourceUriSchema,
  incumbentWorkItemKey: z.string(),
});

// Folded shape of a `wake.correlation.registered`/`wake.correlation.retracted`
// event, one entry per resourceUri currently held by this work item
// (ADR 0001 §5). `registeredAt` comes from the folding event's `occurredAt`.
export const correlatedResourceSchema = z.object({
  resourceUri: resourceUriSchema,
  role: correlationRoleSchema,
  relation: correlationRelationSchema,
  provenance: correlationProvenanceSchema,
  registeredBy: z.string().optional(),
  registeredAt: isoTimestampSchema,
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

export const issueStateRecordSchema = z.object({
  schemaVersion: z.literal(1),
  workItemKey: z.string(),
  origin: z.string().optional(),
  issue: issueSnapshotSchema,
  comments: z.array(commentSnapshotSchema).default([]),
  latestComment: commentSnapshotSchema.optional(),
  wake: z.object({
    stage: identifierSchema,
    lastRunId: z.string().optional(),
    sessionId: z.string().optional(),
    sessionCli: z.string().optional(),
    workspacePath: z.string().optional(),
    blockReason: z.string().optional(),
    syncedAt: isoTimestampSchema,
    stageHistory: z.array(stageHistoryEntrySchema),
    recentEventIds: z.array(z.string()).default([]),
    expectedEcho: z
      .object({
        commentIds: z.array(z.string()).default([]),
        labels: z.array(z.string()).default([]),
      })
      .default({ commentIds: [], labels: [] }),
  }),
  context: z.record(z.string(), z.unknown()).default({}),
  correlatedResources: z.array(correlatedResourceSchema).default([]),
});

const runTokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheCreationInputTokens: z.number().nonnegative().optional(),
  cacheReadInputTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  turns: z.number().nonnegative().optional(),
});

export const runRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  // The work item this run belongs to. Required: run records are Wake-owned
  // state that Wake itself writes, so the work id is always in hand at the
  // write site, and an optional key would lie about runtime while re-admitting
  // the ticket-shaped ambiguity minted identity exists to remove.
  workItemKey: z.string(),
  // Human-readable representation content only — the ticket this run was
  // launched against (same reasoning as the projection's retained `issue`
  // snapshot, spec §9). Never used to find the work item: a transferred issue
  // gets a new repo/number while the work item and its runs persist (spec D3).
  repo: z.string(),
  issueNumber: z.number().int().positive(),
  action: identifierSchema,
  status: z.enum(['running', 'completed', 'awaiting-approval', 'blocked', 'failed', 'superseded']),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.optional(),
  sessionId: z.string().optional(),
  sentinel: runnerSentinelSchema.optional(),
  summary: z.string().optional(),
  routing: runnerRoutingSchema.optional(),
  tokenUsage: runTokenUsageSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const runnerHealthEntrySchema = z.object({
  pausedUntil: isoTimestampSchema.optional(),
  // 'reported' = CLI told us the real reset time; 'estimated' = exponential
  // backoff guess. Only 'estimated' pauses are eligible for an early recovery
  // probe (domain/runner-routing.ts) - a reported time is already trustworthy.
  pausedUntilSource: z.enum(['reported', 'estimated']).optional(),
  failureCount: z.number().int().nonnegative().default(0),
  lastFailureAt: isoTimestampSchema.optional(),
});

const workflowWorkspaceSchema = z.enum(['none', 'read-only', 'branch']);

const workflowStageSchema = stageRouteSchema.extend({
  workspace: workflowWorkspaceSchema,
  onDone: identifierSchema,
});

const workflowDefinitionSchema = z.object({
  entryStage: identifierSchema.optional(),
  stages: z.record(identifierSchema, workflowStageSchema),
});

function defaultPromptsRoot(): string {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(process.cwd(), 'prompts'),
    join(sourceDir, '..', '..', 'prompts'),
    join(sourceDir, '..', '..', '..', 'prompts'),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  let dir = sourceDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      return join(dir, 'prompts');
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return join(process.cwd(), 'prompts');
}

function promptExists(promptsRoot: string, stageOrAction: string): boolean {
  return (
    existsSync(join(promptsRoot, `${stageOrAction}.md`)) ||
    existsSync(join(promptsRoot, `${stageOrAction}.start.md`)) ||
    existsSync(join(promptsRoot, `${stageOrAction}.resume.md`))
  );
}

function canReachDone(start: string, stages: Record<string, { onDone: string }>): boolean {
  const seen = new Set<string>();
  let current = start;

  while (current !== 'done') {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);

    const next = stages[current]?.onDone;
    if (next === undefined) {
      return false;
    }
    current = next;
  }

  return true;
}

export const ledgerSchema = z.object({
  schemaVersion: z.literal(1),
  // Legacy single-runner pause fields, superseded by `runners` (per-runner
  // health, #67). Kept read-only so ledgers written before the fallback/rotation
  // change still parse; nothing writes them anymore.
  pausedUntil: isoTimestampSchema.optional(),
  quotaFailureCount: z.number().int().nonnegative().optional(),
  lastQuotaFailureAt: isoTimestampSchema.optional(),
  runners: z.record(z.string(), runnerHealthEntrySchema).default({}),
});

export const wakeConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    paths: z.object({
      wakeRoot: z.string(),
      promptsRoot: z.string().optional(),
    }),
    sandbox: z
      .object({
        image: z.string().min(1).default('wake-sandbox'),
        // Base image name (no tag) that `wake sandbox self-update` appends a
        // release tag to, e.g. "wake-sandbox:v0.0.80". `image` above stays the
        // resolved ref that `build`/`up`/`update` actually run.
        imageRepository: z.string().min(1).default('wake-sandbox'),
        containerName: z.string().min(1).default('wake-sandbox'),
        containerMountPath: z.string().min(1).default('/wake'),
        containerHomeMountPath: z.string().min(1).default('/home/wake'),
        start: z
          .object({
            enabled: z.boolean().default(true),
          })
          .default({ enabled: true }),
        extraMounts: z
          .array(
            z.object({
              source: z.string().min(1),
              target: z.string().min(1),
              readOnly: z.boolean().optional(),
            }),
          )
          .default([]),
      })
      .default({
        image: 'wake-sandbox',
        imageRepository: 'wake-sandbox',
        containerName: 'wake-sandbox',
        containerMountPath: '/wake',
        containerHomeMountPath: '/home/wake',
        start: { enabled: true },
        extraMounts: [],
      }),
    dev: z
      .object({
        repoRoot: z.string().optional(),
      })
      .default({}),
    scheduler: z
      .object({
        intervalMs: z
          .number()
          .int()
          .positive()
          .default(60 * 1000),
        // Cap for the idle-cadence backoff (#81): consecutive idle ticks double the
        // sleep, up to this ceiling, so a quiet repo doesn't poll every intervalMs.
        maxIntervalMs: z
          .number()
          .int()
          .positive()
          .default(5 * 60 * 1000),
      })
      .default({ intervalMs: 60 * 1000, maxIntervalMs: 5 * 60 * 1000 }),
    transcripts: z
      .object({
        enabled: z.boolean().default(false),
        retainAfterWorkspaceCleanup: z.boolean().default(false),
      })
      .default({ enabled: false, retainAfterWorkspaceCleanup: false }),
    runners: z.record(z.string(), runnerEntrySchema).default({
      fake: { kind: 'fake', cli: 'Fake' },
      'claude-haiku': {
        kind: 'claude',
        command: 'claude',
        model: 'haiku',
        smokeModel: 'haiku',
        sessionName: defaultAgentIdentity,
        remoteControlName: defaultAgentIdentity,
        smokePrompt: defaultSmokePrompt,
        timeoutMs: 30 * 60 * 1000,
        remoteControl: { enabled: false },
        models: { default: 'haiku' },
      },
      'claude-opus': {
        kind: 'claude',
        command: 'claude',
        model: 'claude-opus-4-8',
        smokeModel: 'haiku',
        sessionName: defaultAgentIdentity,
        remoteControlName: defaultAgentIdentity,
        smokePrompt: defaultSmokePrompt,
        timeoutMs: 30 * 60 * 1000,
        remoteControl: { enabled: false },
        models: { default: 'claude-opus-4-8' },
      },
      'codex-mini': {
        kind: 'codex',
        command: 'codex',
        model: 'gpt-5.4-mini',
        smokeModel: 'gpt-5.4-mini',
        smokePrompt: defaultSmokePrompt,
        timeoutMs: 30 * 60 * 1000,
        models: { default: 'gpt-5.4-mini', implement: 'gpt-5.4-mini' },
      },
      'codex-flagship': {
        kind: 'codex',
        command: 'codex',
        model: 'gpt-5.5',
        smokeModel: 'gpt-5.4-mini',
        smokePrompt: defaultSmokePrompt,
        timeoutMs: 30 * 60 * 1000,
        models: { default: 'gpt-5.5', implement: 'gpt-5.5' },
      },
      'cursor-composer': {
        kind: 'cursor',
        command: 'cursor',
        model: 'composer-2.5',
        smokeModel: 'auto',
        smokePrompt: defaultSmokePrompt,
        timeoutMs: 30 * 60 * 1000,
        models: { default: 'composer-2.5', implement: 'composer-2.5' },
      },
    }),
    tiers: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({
      light: ['fake'],
      standard: ['fake'],
      deep: ['fake'],
    }),
    defaultTier: z.string().default('standard'),
    workflows: z.record(identifierSchema, workflowDefinitionSchema).default({
      default: {
        stages: {
          refine: {
            action: 'refine',
            workspace: 'read-only',
            tier: 'light',
            onDone: 'implement',
          },
          implement: {
            action: 'implement',
            workspace: 'branch',
            tier: 'standard',
            onDone: 'done',
          },
        },
      },
    }),
    stages: z.record(z.string(), stageRouteSchema).default({
      queue: { action: 'refine', tier: 'light' },
      implement: { action: 'implement', tier: 'standard' },
    }),
    ui: z
      .object({
        enabled: z.boolean().default(false),
        port: z.number().int().positive().default(4317),
        token: z.string().optional(),
        tunnel: z
          .object({
            enabled: z.boolean().default(false),
            authToken: z.string().optional(),
          })
          .default({ enabled: false }),
        archiveFreshnessDays: z.number().int().nonnegative().default(5),
      })
      .default({ enabled: false, port: 4317, tunnel: { enabled: false }, archiveFreshnessDays: 5 }),
    sources: z
      .object({
        github: z
          .object({
            enabled: z.boolean().default(false),
            repos: z.array(z.string().min(1)).default([]),
            polling: z
              .object({
                maxIssuesPerRepo: z.number().int().positive().default(25),
                commentPageSize: z.number().int().positive().default(25),
                lookbackMs: z.number().int().nonnegative().default(60_000),
              })
              .default({ maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 }),
            policy: z
              .object({
                requiredLabels: z.array(z.string()).default([]),
                ignoredLabels: z.array(z.string()).default([]),
                requiredAssignees: z.array(z.string()).default([]),
              })
              .default({ requiredLabels: [], ignoredLabels: [], requiredAssignees: [] }),
            publication: z
              .object({
                postStatusComments: z.boolean().default(true),
                activeLabel: z.string().optional(),
              })
              .default({ postStatusComments: true }),
            pullRequests: z
              .object({
                enabled: z.boolean().default(false),
                maxPullRequestsPerRepo: z.number().int().positive().default(25),
                commentPageSize: z.number().int().positive().default(25),
                policy: z
                  .object({
                    requiredAuthors: z.array(z.string()).default([]),
                  })
                  .default({ requiredAuthors: [] }),
              })
              .default({
                enabled: false,
                maxPullRequestsPerRepo: 25,
                commentPageSize: 25,
                policy: { requiredAuthors: [] },
              }),
          })
          .default({
            enabled: false,
            repos: [],
            polling: { maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 },
            policy: { requiredLabels: [], ignoredLabels: [], requiredAssignees: [] },
            publication: { postStatusComments: true },
            pullRequests: {
              enabled: false,
              maxPullRequestsPerRepo: 25,
              commentPageSize: 25,
              policy: { requiredAuthors: [] },
            },
          }),
      })
      .default({
        github: {
          enabled: false,
          repos: [],
          polling: { maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 },
          policy: { requiredLabels: [], ignoredLabels: [], requiredAssignees: [] },
          publication: { postStatusComments: true },
          pullRequests: {
            enabled: false,
            maxPullRequestsPerRepo: 25,
            commentPageSize: 25,
            policy: { requiredAuthors: [] },
          },
        },
      }),
    sinks: z.record(z.string(), sinkEntrySchema).default({}),
  })
  .superRefine((config, ctx) => {
    const promptsRoot = config.paths.promptsRoot ?? defaultPromptsRoot();
    const workflowEntries = Object.entries(config.workflows);
    if (workflowEntries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workflows'],
        message: 'At least one workflow must be configured.',
      });
    }

    for (const [workflowName, workflow] of workflowEntries) {
      const stageNames = Object.keys(workflow.stages);
      const stageSet = new Set(stageNames);

      if (stageNames.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workflows', workflowName, 'stages'],
          message: 'Workflow must define at least one runnable stage.',
        });
        continue;
      }

      for (const reserved of ['queue', 'done']) {
        if (stageSet.has(reserved)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['workflows', workflowName, 'stages', reserved],
            message: `Workflow must not define implicit ${reserved} stage.`,
          });
        }
      }

      const actualEntryStage = workflow.entryStage ?? stageNames[0];
      if (workflow.entryStage === 'queue') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workflows', workflowName, 'entryStage'],
          message: 'Workflow entryStage must not be queue.',
        });
      }
      if (actualEntryStage !== undefined && !stageSet.has(actualEntryStage)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workflows', workflowName, 'entryStage'],
          message: `Workflow entryStage "${actualEntryStage}" is not a configured stage.`,
        });
      }

      for (const [stageName, stage] of Object.entries(workflow.stages)) {
        if (stage.onDone === 'queue') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['workflows', workflowName, 'stages', stageName, 'onDone'],
            message: 'Workflow transitions must not target queue.',
          });
        }
        if (stage.onDone !== 'done' && !stageSet.has(stage.onDone)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['workflows', workflowName, 'stages', stageName, 'onDone'],
            message: `Workflow transition targets unknown stage "${stage.onDone}".`,
          });
        }
        if (stage.action === undefined && !promptExists(promptsRoot, stageName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['workflows', workflowName, 'stages', stageName, 'action'],
            message: `Workflow stage "${stageName}" omits action but no prompts/${stageName}.md template exists.`,
          });
        }
      }

      if (
        actualEntryStage !== undefined &&
        stageSet.has(actualEntryStage) &&
        !canReachDone(actualEntryStage, workflow.stages)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workflows', workflowName],
          message: 'Workflow cannot reach done from its entry stage.',
        });
      }
    }
  });

export const claudePrintResultSchema = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    result: z.string(),
    session_id: z.string().optional(),
    total_cost_usd: z.number().optional(),
    num_turns: z.number().optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

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
  return structuredClone(wakeConfigSchema.parse(input));
}

export function parseSourceStateRecord(input: unknown) {
  return sourceStateRecordSchema.parse(input);
}

export function parseClaudePrintResult(input: unknown) {
  return claudePrintResultSchema.parse(input);
}

function synthesizeBodyFromEnvelope(envelope: z.infer<typeof wakeResultEnvelopeSchema>): string {
  const labels: Record<string, string> = {
    DONE: 'Run completed.',
    BLOCKED: 'Run blocked — needs input.',
    AWAITING_APPROVAL: 'Ready for approval.',
    FAILED: 'Run failed.',
  };
  return labels[envelope.status] ?? 'Run finished.';
}

export function parseRunnerResult(result: string): {
  status: 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL';
  body: string;
  envelope: 'structured' | 'degraded';
  result?: z.infer<typeof wakeResultEnvelopeSchema>;
} {
  const wakeResultFencePattern =
    /^```(?:wake-result[^\n]*\n|[ \t]*\n[ \t]*wake-result[ \t]*\n)([\s\S]*?)^```[ \t]*$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;

  while ((match = wakeResultFencePattern.exec(result)) !== null) {
    lastMatch = match;
  }

  if (lastMatch !== null) {
    try {
      const rawContent = lastMatch[1] ?? 'null';
      // Claude sometimes places the sentinel keyword inside the fence rather than after
      // the closing fence. Strip a trailing sentinel line so JSON.parse sees only the JSON.
      // The capture group includes the newline before the closing fence, so allow \n? after.
      const jsonContent =
        rawContent.replace(/\n(?:DONE|BLOCKED|FAILED|AWAITING_APPROVAL)[ \t]*\n?$/, '') ||
        rawContent;
      const parsed = wakeResultEnvelopeSchema.safeParse(JSON.parse(jsonContent));
      if (parsed.success) {
        const proseBody = result.slice(0, lastMatch.index).trim();
        return {
          status: parsed.data.status,
          body: proseBody || synthesizeBodyFromEnvelope(parsed.data),
          envelope: 'structured',
          result: parsed.data,
        };
      }
    } catch {
      // Invalid structured trailers intentionally degrade to last-line parsing.
    }
  }

  const offFenceEnvelopePattern = /^```wake-result[^\n]*\n```[ \t]*\n(\{[^\n]+\})[ \t]*$/gm;
  let offFenceMatch: RegExpExecArray | null = null;
  while ((match = offFenceEnvelopePattern.exec(result)) !== null) {
    offFenceMatch = match;
  }
  if (offFenceMatch !== null) {
    try {
      const parsed = wakeResultEnvelopeSchema.safeParse(JSON.parse(offFenceMatch[1] ?? 'null'));
      if (parsed.success) {
        return {
          status: parsed.data.status,
          body:
            result.slice(0, offFenceMatch.index).trim() || synthesizeBodyFromEnvelope(parsed.data),
          envelope: 'structured',
          result: parsed.data,
        };
      }
    } catch {
      // Invalid off-fence trailers intentionally degrade to sentinel parsing.
    }
  }

  const lines = result.split('\n');
  const lastLine = lines
    .map((line) => line.trim())
    // Skip closing code fence lines — they appear as the last non-empty line when the
    // sentinel is embedded inside the fenced block or when a plain ``` fence is used.
    .filter((line) => line.length > 0 && line !== '```')
    .at(-1);

  const normalizedLastLine = lastLine?.replace(/^(?:\*\*|__)(.+)(?:\*\*|__)$/, '$1');
  const parsed = runnerSentinelSchema.safeParse(normalizedLastLine);
  if (!parsed.success) {
    const body = result.trim();
    return {
      status: body.length === 0 ? 'FAILED' : 'BLOCKED',
      body,
      envelope: 'degraded',
    };
  }

  let removed = false;
  const body = lines
    .slice()
    .reverse()
    .filter((line) => {
      if (!removed && line.trim() === lastLine) {
        removed = true;
        return false;
      }
      return true;
    })
    .reverse()
    .join('\n')
    .trim();

  return {
    status: parsed.data,
    body,
    envelope: 'degraded',
  };
}

export function parseRunnerArtifacts(result: string): z.infer<typeof wakeArtifactsEnvelopeSchema> {
  const fencePattern = /^```wake-artifacts[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(result)) !== null) {
    lastMatch = match;
  }

  if (lastMatch === null) {
    return { artifacts: [] };
  }

  try {
    const parsed = wakeArtifactsEnvelopeSchema.safeParse(JSON.parse(lastMatch[1] ?? '{}'));
    return parsed.success ? parsed.data : { artifacts: [] };
  } catch {
    return { artifacts: [] };
  }
}

export function parseRunnerResultSentinel(
  result: string,
): 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL' {
  return parseRunnerResult(result).status;
}
