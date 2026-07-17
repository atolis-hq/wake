import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  correlationPrimaryConflictPayloadSchema,
  correlationRegisteredPayloadSchema,
  correlationRetractedPayloadSchema,
  eventEnvelopeSchema,
  eventEnvelopeSourceRefsSchema,
  parseEventEnvelope,
  parseIssueStateRecord,
  parseSourceStateRecord,
  parseWakeConfig,
  parseRunRecord,
  parseRunnerResult,
  parseRunnerResultSentinel,
  workItemCreatedPayloadSchema,
  CORRELATION_PRIMARY_CONFLICT_EVENT,
  CORRELATION_REGISTERED_EVENT,
  CORRELATION_RETRACTED_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from '../../src/domain/schema.js';
import type { WakeDevConfig, WakeSandboxConfig } from '../../src/domain/types.js';

describe('issue state schema', () => {
  it('accepts canonical issue and comment fields plus extensible context', () => {
    const record = parseIssueStateRecord({
      schemaVersion: 1,
      workItemKey: 'work-01JZ0000000000000000000012',
      origin: 'github',
      issue: {
        repo: 'atolis-hq/wake',
        number: 12,
        title: 'Example',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/12',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [
        {
          id: 'c1',
          body: 'Need more detail',
          author: { login: 'shared-user' },
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
      ],
      wake: {
        stage: 'queue',
        stageHistory: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {
        agentBrief: 'Extra information for future prompts',
      },
    });

    expect(record.context.agentBrief).toBe('Extra information for future prompts');
    expect(record.wake.expectedEcho).toEqual({ commentIds: [], labels: [] });
    expect(record.issue.isPullRequest).toBe(false);
    // The key is taken verbatim: nothing derives, namespaces, or rewrites it.
    expect(record.workItemKey).toBe('work-01JZ0000000000000000000012');
  });

  it('requires an explicit workItemKey rather than deriving one from the issue', () => {
    // Identity is minted by the resolver and stamped on the record; a
    // projection that arrives without one is a bug, not a record to guess a
    // key for (spec §1/D1).
    expect(() =>
      parseIssueStateRecord({
        schemaVersion: 1,
        issue: {
          repo: 'atolis-hq/wake',
          number: 12,
          title: 'Example',
          body: 'Body',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/12',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        wake: {
          stage: 'queue',
          stageHistory: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
        },
      }),
    ).toThrow(/workItemKey/);
  });

  it('accepts an explicit pull-request discriminator on canonical issues', () => {
    const record = parseIssueStateRecord({
      schemaVersion: 1,
      workItemKey: 'work-01JZ0000000000000000000014',
      issue: {
        repo: 'atolis-hq/wake',
        number: 14,
        title: 'Example PR',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: true,
        state: 'open',
        url: 'https://example.test/pull/14',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      wake: {
        stage: 'queue',
        stageHistory: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
    });

    expect(record.issue.isPullRequest).toBe(true);
  });

  it('rejects missing canonical wake stage', () => {
    expect(() =>
      parseIssueStateRecord({
        schemaVersion: 1,
        issue: {},
        comments: [],
        wake: {},
      }),
    ).toThrow(/stage/i);
  });

  // The legacy-stage normalization tests ('refined'/'failed'/'blocked' →
  // canonical stages) are gone with the .preprocess() that implemented them.
  // The sanctioned fresh start of .wake/ means there is no event log or
  // projection written under the old vocabulary left to read (spec §8).
});

describe('run and event schemas', () => {
  it('exports an explicit sandbox config helper type', () => {
    expectTypeOf<WakeSandboxConfig>().toEqualTypeOf<{
      image: string;
      imageRepository: string;
      containerName: string;
      containerMountPath: string;
      containerHomeMountPath: string;
      start: { enabled: boolean };
      extraMounts: Array<{
        source: string;
        target: string;
        readOnly?: boolean;
      }>;
    }>();
  });

  it('exports an explicit local-development config helper type', () => {
    expectTypeOf<WakeDevConfig>().toEqualTypeOf<{
      repoRoot?: string;
    }>();
  });

  it('accepts running run records', () => {
    const run = parseRunRecord({
      schemaVersion: 1,
      runId: 'run-1',
      workItemKey: 'work-01JZ0000000000000000000012',
      repo: 'atolis-hq/wake',
      issueNumber: 12,
      action: 'refine',
      status: 'running',
      startedAt: '2026-07-05T12:00:00.000Z',
    });

    expect(run.status).toBe('running');
    expect(run.workItemKey).toBe('work-01JZ0000000000000000000012');
  });

  // Run records are Wake-owned state that Wake itself writes, so the work id is
  // always in hand at the write site. Required rather than optional: an optional
  // key would let a record exist that can only be resolved by scanning issue
  // snapshots — the ticket-shaped ambiguity minted identity exists to remove.
  it('rejects run records with no workItemKey', () => {
    expect(() =>
      parseRunRecord({
        schemaVersion: 1,
        runId: 'run-1',
        repo: 'atolis-hq/wake',
        issueNumber: 12,
        action: 'refine',
        status: 'running',
        startedAt: '2026-07-05T12:00:00.000Z',
      }),
    ).toThrow(/workItemKey/);
  });

  it('accepts canonical event envelopes with work item correlation', () => {
    const event = parseEventEnvelope({
      schemaVersion: 1,
      eventId: 'evt-1',
      workItemKey: 'work-01JZ0000000000000000000012',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'github.issue.comment.created',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 12,
        commentId: 'c-1',
        sourceUrl: 'https://example.test/issues/12#issuecomment-1',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'immediate',
      payload: {
        body: 'Need more detail',
      },
      raw: {
        body: 'Need more detail',
      },
      derivedHints: {
      },
    });

    // Taken verbatim from the envelope: the resolver stamped it, and nothing
    // in the parse namespaces, derives, or rewrites it (spec §8).
    expect(event.workItemKey).toBe('work-01JZ0000000000000000000012');
    expect(event.streamScope).toBe('work-item');
  });

  it('accepts a valid resourceUri on sourceRefs', () => {
    const refs = eventEnvelopeSourceRefsSchema.parse({
      resourceUri: 'github:pr:atolis-hq/wake#91',
    });

    expect(refs.resourceUri).toBe('github:pr:atolis-hq/wake#91');
  });

  it('rejects a malformed resourceUri on sourceRefs', () => {
    expect(() =>
      eventEnvelopeSourceRefsSchema.parse({ resourceUri: 'not-a-resource-uri' }),
    ).toThrow();
  });

  it('parses sourceRefs successfully when resourceUri is absent', () => {
    const refs = eventEnvelopeSourceRefsSchema.parse({
      repo: 'atolis-hq/wake',
      issueNumber: 12,
    });

    expect(refs.resourceUri).toBeUndefined();
  });

  it('accepts a full correlation registered payload', () => {
    const payload = correlationRegisteredPayloadSchema.parse({
      resourceUri: 'github:pr:atolis-hq/wake#91',
      role: 'implementation',
      relation: 'primary',
      provenance: 'operator-declared',
      registeredBy: 'run-1',
    });

    expect(payload.registeredBy).toBe('run-1');
  });

  it('accepts a correlation registered payload with registeredBy omitted', () => {
    const payload = correlationRegisteredPayloadSchema.parse({
      resourceUri: 'github:pr:atolis-hq/wake#91',
      role: 'implementation',
      relation: 'primary',
      provenance: 'operator-declared',
    });

    expect(payload.registeredBy).toBeUndefined();
  });

  it('rejects a correlation registered payload with an unknown role', () => {
    expect(() =>
      correlationRegisteredPayloadSchema.parse({
        resourceUri: 'github:pr:atolis-hq/wake#91',
        role: 'pr',
        relation: 'primary',
        provenance: 'operator-declared',
      }),
    ).toThrow();
  });

  it('rejects a correlation registered payload with an unknown relation', () => {
    expect(() =>
      correlationRegisteredPayloadSchema.parse({
        resourceUri: 'github:pr:atolis-hq/wake#91',
        role: 'implementation',
        relation: 'tertiary',
        provenance: 'operator-declared',
      }),
    ).toThrow();
  });

  it('rejects a correlation registered payload with an unknown provenance', () => {
    expect(() =>
      correlationRegisteredPayloadSchema.parse({
        resourceUri: 'github:pr:atolis-hq/wake#91',
        role: 'implementation',
        relation: 'primary',
        provenance: 'human-declared',
      }),
    ).toThrow();
  });

  it('rejects a correlation registered payload with a malformed resourceUri', () => {
    expect(() =>
      correlationRegisteredPayloadSchema.parse({
        resourceUri: 'not-a-resource-uri',
        role: 'implementation',
        relation: 'primary',
        provenance: 'operator-declared',
      }),
    ).toThrow();
  });

  it('accepts a correlation retracted payload', () => {
    const payload = correlationRetractedPayloadSchema.parse({
      resourceUri: 'github:pr:atolis-hq/wake#91',
    });

    expect(payload.resourceUri).toBe('github:pr:atolis-hq/wake#91');
  });

  it('rejects a correlation retracted payload missing resourceUri', () => {
    expect(() => correlationRetractedPayloadSchema.parse({})).toThrow();
  });

  it('accepts an empty work item created payload', () => {
    expect(workItemCreatedPayloadSchema.parse({})).toEqual({});
  });

  it('accepts a correlation primary-conflict payload', () => {
    const payload = correlationPrimaryConflictPayloadSchema.parse({
      resourceUri: 'github:pr:atolis-hq/wake#91',
      incumbentWorkItemKey: 'work-01ABC',
    });

    expect(payload.incumbentWorkItemKey).toBe('work-01ABC');
  });

  it('round-trips a wake.correlation.registered envelope through eventEnvelopeSchema', () => {
    const event = parseEventEnvelope({
      schemaVersion: 1,
      eventId: 'evt-2',
      workItemKey: 'work-01JXYZ',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: CORRELATION_REGISTERED_EVENT,
      sourceRefs: {
        resourceUri: 'github:pr:atolis-hq/wake#91',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'context-only',
      payload: correlationRegisteredPayloadSchema.parse({
        resourceUri: 'github:pr:atolis-hq/wake#91',
        role: 'implementation',
        relation: 'primary',
        provenance: 'operator-declared',
        registeredBy: 'run-1',
      }),
    });

    expect(event.sourceEventType).toBe(CORRELATION_REGISTERED_EVENT);
    expect(event.sourceRefs.resourceUri).toBe('github:pr:atolis-hq/wake#91');
    expect(event.payload).toEqual({
      resourceUri: 'github:pr:atolis-hq/wake#91',
      role: 'implementation',
      relation: 'primary',
      provenance: 'operator-declared',
      registeredBy: 'run-1',
    });
  });

  it('exposes the four correlation event type constants', () => {
    expect(WORK_ITEM_CREATED_EVENT).toBe('wake.workitem.created');
    expect(CORRELATION_REGISTERED_EVENT).toBe('wake.correlation.registered');
    expect(CORRELATION_RETRACTED_EVENT).toBe('wake.correlation.retracted');
    expect(CORRELATION_PRIMARY_CONFLICT_EVENT).toBe('wake.correlation.primary-conflict');
    expect(eventEnvelopeSchema).toBeDefined();
  });

  it('parses the sentinel from the last non-empty line only', () => {
    expect(parseRunnerResultSentinel('notes DONE more notes\nFAILED')).toBe('FAILED');
    expect(parseRunnerResultSentinel('notes DONE more notes\nDONE')).toBe('DONE');
  });

  // The legacy `blockedFromAction` → `lastRunAction` context normalization is
  // gone with the .preprocess() that implemented it: the fresh start leaves no
  // projection written under the old key (spec §8, "no migration code").

  it('parses the last valid wake-result envelope and keeps only prose before it as body', () => {
    const parsed = parseRunnerResult([
      'The prose mentions FAILED legitimately.',
      '',
      '```wake-result',
      '{ "status": "BLOCKED" }',
      '```',
      '',
      'Updated summary after an earlier sample.',
      '',
      '```wake-result',
      '{ "status": "DONE", "ignored": true }',
      '```',
      'DONE',
    ].join('\n'));

    expect(parsed).toEqual({
      status: 'DONE',
      body: [
        'The prose mentions FAILED legitimately.',
        '',
        '```wake-result',
        '{ "status": "BLOCKED" }',
        '```',
        '',
        'Updated summary after an earlier sample.',
      ].join('\n'),
      envelope: 'structured',
      result: {
        status: 'DONE',
      },
    });
  });

  it('synthesizes a generic status body for AWAITING_APPROVAL when structured envelope has no prose', () => {
    const parsed = parseRunnerResult([
      '```wake-result',
      '{"status":"AWAITING_APPROVAL"}',
      '```',
      'AWAITING_APPROVAL',
    ].join('\n'));

    expect(parsed.status).toBe('AWAITING_APPROVAL');
    expect(parsed.envelope).toBe('structured');
    expect(parsed.body).toBeTruthy();
  });

  it('synthesizes a generic status sentence when structured envelope has no prose', () => {
    const parsed = parseRunnerResult([
      '```wake-result',
      '{"status":"DONE"}',
      '```',
      'DONE',
    ].join('\n'));

    expect(parsed.status).toBe('DONE');
    expect(parsed.envelope).toBe('structured');
    expect(parsed.body).toBeTruthy();
  });

  it('does not synthesize body when prose already precedes the structured envelope', () => {
    const parsed = parseRunnerResult([
      'Here is my plan.',
      '',
      '```wake-result',
      '{"status":"AWAITING_APPROVAL"}',
      '```',
      'AWAITING_APPROVAL',
    ].join('\n'));

    expect(parsed.body).toBe('Here is my plan.');
  });

  it('degrades to the final bare sentinel when the wake-result envelope is malformed', () => {
    const parsed = parseRunnerResult([
      'Summary',
      '',
      '```wake-result',
      '{ "status": "NOT_A_STATUS" }',
      '```',
      'BLOCKED',
    ].join('\n'));

    expect(parsed.status).toBe('BLOCKED');
    expect(parsed.envelope).toBe('degraded');
    expect(parsed.body).toBe('Summary\n\n```wake-result\n{ "status": "NOT_A_STATUS" }\n```');
  });

  it('parses structured envelope when sentinel is inside the fenced block', () => {
    const parsed = parseRunnerResult([
      'PR opened and ready for review.',
      '',
      '```wake-result',
      '{"status": "AWAITING_APPROVAL"}',
      'AWAITING_APPROVAL',
      '```',
    ].join('\n'));

    expect(parsed.status).toBe('AWAITING_APPROVAL');
    expect(parsed.envelope).toBe('structured');
    expect(parsed.body).toBe('PR opened and ready for review.');
  });

  it('falls back to sentinel inside block when structured parse fails and closing fence is last line', () => {
    const parsed = parseRunnerResult([
      'Summary.',
      '',
      '```wake-result',
      '{ "status": "NOT_A_STATUS" }',
      'BLOCKED',
      '```',
    ].join('\n'));

    expect(parsed.status).toBe('BLOCKED');
    expect(parsed.envelope).toBe('degraded');
  });

  it('accepts markdown-decorated sentinels on the final line', () => {
    const parsed = parseRunnerResult('I need the repository owner to choose.\n\n**BLOCKED**');

    expect(parsed.status).toBe('BLOCKED');
    expect(parsed.body).toBe('I need the repository owner to choose.');
    expect(parsed.envelope).toBe('degraded');
  });

  it('parses an off-fence wake-result envelope', () => {
    const parsed = parseRunnerResult([
      'I need one missing detail.',
      '',
      '```wake-result',
      '```',
      '{"status":"BLOCKED"}',
    ].join('\n'));

    expect(parsed.status).toBe('BLOCKED');
    expect(parsed.body).toBe('I need one missing detail.');
    expect(parsed.envelope).toBe('structured');
  });

  it('parses wake-result when its marker is on the line after the fence opener', () => {
    const parsed = parseRunnerResult([
      'I need one missing detail.',
      '',
      '```',
      'wake-result',
      '{"status":"BLOCKED"}',
      '```',
    ].join('\n'));

    expect(parsed.status).toBe('BLOCKED');
    expect(parsed.body).toBe('I need one missing detail.');
    expect(parsed.envelope).toBe('structured');
  });

  it('treats substantive degraded output without a sentinel as blocked', () => {
    const parsed = parseRunnerResult('Should I create a migration or preserve the legacy format?');

    expect(parsed.status).toBe('BLOCKED');
    expect(parsed.envelope).toBe('degraded');
  });

  it('does not match a sentinel word embedded in prose on the last line', () => {
    // Last line contains prose, not an exact sentinel — should fall back to FAILED
    expect(parseRunnerResultSentinel('notes DONE more notes FAILED')).toBe('BLOCKED');
    expect(parseRunnerResultSentinel('the previous run FAILED, so I re-ran the tests\nIf they had FAILED again it would be bad\nDONE. Finished.')).toBe('BLOCKED');
  });

  it('parses AWAITING_APPROVAL sentinel from last line', () => {
    expect(parseRunnerResultSentinel('Work complete, awaiting sign-off\nAWAITING_APPROVAL')).toBe('AWAITING_APPROVAL');
  });

  it('blocks on substantive output and fails on empty output when no sentinel is present', () => {
    expect(parseRunnerResultSentinel('Should I proceed with creating the worktree?')).toBe('BLOCKED');
    expect(parseRunnerResultSentinel('')).toBe('FAILED');
  });

  it('accepts source state records for provider poll watermarks', () => {
    const sourceState = parseSourceStateRecord({
      schemaVersion: 1,
      source: 'github',
      key: 'atolis-hq/wake',
      lastSuccessfulPollAt: '2026-07-05T12:00:00.000Z',
    });

    expect(sourceState.source).toBe('github');
  });

  it('accepts github source configuration', () => {
    const config = parseWakeConfig({
      schemaVersion: 1,
      paths: {
        wakeRoot: '/tmp/wake',
        promptsRoot: '/tmp/wake/prompts',
      },
      sandbox: {
        image: 'wake-sandbox',
        containerName: 'wake-sandbox-1',
        containerMountPath: '/wake',
        containerHomeMountPath: '/home/wake',
        extraMounts: [
          {
            source: '/host/.claude/skills',
            target: '/home/wake/.claude/skills',
            readOnly: true,
          },
        ],
      },
      scheduler: {
        intervalMs: 1000,
      },
      runner: {
        mode: 'fake',
        claude: {
          command: 'claude',
          model: 'haiku',
          smokeModel: 'haiku',
          sessionName: 'Eddy',
          remoteControlName: 'Eddy',
          smokePrompt: 'hi',
          timeoutMs: 60_000,
          remoteControl: {
            enabled: false,
          },
        },
      },
      sources: {
        github: {
          enabled: false,
          repos: ['atolis-hq/wake'],
          polling: {
            maxIssuesPerRepo: 25,
            commentPageSize: 25,
            lookbackMs: 60000,
          },
          policy: {
            requiredLabels: [],
            ignoredLabels: [],
            requiredAssignees: [],
          },
          publication: {
            postStatusComments: true,
          },
        },
      },
    });

    expect(config.sources.github.repos).toEqual(['atolis-hq/wake']);
    expect(config.paths.promptsRoot).toBe('/tmp/wake/prompts');
    expect(config.sandbox.containerName).toBe('wake-sandbox-1');
    expect(config.sandbox.start).toEqual({ enabled: true });
    expect(config.transcripts).toEqual({ enabled: false, retainAfterWorkspaceCleanup: false });
    expect(config.ui.archiveFreshnessDays).toBe(5);
    expect(config.ui.tunnel).toEqual({ enabled: false });
    expect(config.sandbox.extraMounts).toEqual([
      {
        source: '/host/.claude/skills',
        target: '/home/wake/.claude/skills',
        readOnly: true,
      },
    ]);
  });

  it('accepts transcript logging configuration', () => {
    const config = parseWakeConfig({
      schemaVersion: 1,
      paths: {
        wakeRoot: '/tmp/wake',
      },
      transcripts: {
        enabled: true,
        retainAfterWorkspaceCleanup: true,
      },
    });

    expect(config.transcripts).toEqual({
      enabled: true,
      retainAfterWorkspaceCleanup: true,
    });
  });

  it('accepts codex runner configuration via registry', () => {
    const config = parseWakeConfig({
      schemaVersion: 1,
      paths: {
        wakeRoot: '/tmp/wake',
      },
      runners: {
        'codex-flagship': {
          kind: 'codex',
          command: 'codex',
          model: 'gpt-5.5',
          smokeModel: 'gpt-5.4-mini',
          smokePrompt: 'hello',
          timeoutMs: 60_000,
        },
      },
    });

    const entry = config.runners['codex-flagship'];
    expect(entry?.kind).toBe('codex');
    if (entry?.kind !== 'codex') throw new Error('unreachable');
    expect(entry.command).toBe('codex');
    expect(entry.smokeModel).toBe('gpt-5.4-mini');
  });

  it('accepts named runners and tier routing', () => {
    const config = parseWakeConfig({
      schemaVersion: 1,
      paths: {
        wakeRoot: '/tmp/wake',
      },
      runners: {
        'claude-haiku': {
          kind: 'claude',
          command: 'claude',
          model: 'claude-haiku-4-5',
          timeoutMs: 600_000,
        },
        'claude-opus': {
          kind: 'claude',
          command: 'claude',
          model: 'claude-opus-4-8',
          timeoutMs: 1_800_000,
        },
        fake: {
          kind: 'fake',
        },
      },
      tiers: {
        light: ['claude-haiku'],
        standard: ['claude-haiku'],
        deep: ['claude-opus', 'claude-haiku'],
      },
      defaultTier: 'standard',
      stages: {
        queue: { action: 'refine', tier: 'light' },
        refined: { action: 'implement', runner: 'claude-opus' },
      },
    });

    expect(config.runners['claude-haiku']?.kind).toBe('claude');
    expect(config.tiers.deep).toEqual(['claude-opus', 'claude-haiku']);
    expect(config.stages.refined?.runner).toBe('claude-opus');
  });

  it('accepts optional local-development repo root configuration', () => {
    const config = parseWakeConfig({
      schemaVersion: 1,
      paths: {
        wakeRoot: '/tmp/wake',
      },
      sandbox: {
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        containerMountPath: '/wake',
        containerHomeMountPath: '/home/wake',
        extraMounts: [],
      },
      dev: {
        repoRoot: '/tmp/wake-repo',
      },
      scheduler: {
        intervalMs: 1000,
      },
      runner: {
        mode: 'fake',
        claude: {
          command: 'claude',
          model: 'haiku',
          smokeModel: 'haiku',
          sessionName: 'Eddy',
          remoteControlName: 'Eddy',
          smokePrompt: 'hi',
          timeoutMs: 60_000,
          remoteControl: {
            enabled: false,
          },
        },
      },
      sources: {
        github: {
          enabled: false,
          repos: [],
          polling: {
            maxIssuesPerRepo: 25,
            commentPageSize: 25,
            lookbackMs: 60000,
          },
          policy: {
            requiredLabels: [],
            ignoredLabels: [],
            requiredAssignees: [],
          },
          publication: {
            postStatusComments: true,
          },
        },
      },
    });

    expect(config.dev?.repoRoot).toBe('/tmp/wake-repo');
  });

  it('parses sources.github.policy.requiredAssignees', () => {
    const config = parseWakeConfig({
      schemaVersion: 1,
      paths: {
        wakeRoot: '/tmp/wake',
        promptsRoot: '/tmp/wake/prompts',
      },
      sandbox: {
        image: 'wake-sandbox',
        containerName: 'wake-sandbox-1',
        containerMountPath: '/wake',
        containerHomeMountPath: '/home/wake',
        extraMounts: [
          {
            source: '/host/.claude/skills',
            target: '/home/wake/.claude/skills',
            readOnly: true,
          },
        ],
      },
      scheduler: {
        intervalMs: 1000,
      },
      runner: {
        mode: 'fake',
        claude: {
          command: 'claude',
          model: 'haiku',
          smokeModel: 'haiku',
          sessionName: 'Eddy',
          remoteControlName: 'Eddy',
          smokePrompt: 'hi',
          timeoutMs: 60_000,
          remoteControl: {
            enabled: false,
          },
        },
      },
      sources: {
        github: {
          enabled: false,
          repos: ['atolis-hq/wake'],
          polling: {
            maxIssuesPerRepo: 25,
            commentPageSize: 25,
            lookbackMs: 60000,
          },
          policy: {
            requiredLabels: [],
            ignoredLabels: [],
            requiredAssignees: ['octocat'],
          },
          publication: {
            postStatusComments: true,
          },
        },
      },
    });

    expect(config.sources.github.policy.requiredAssignees).toEqual(['octocat']);
  });
});
