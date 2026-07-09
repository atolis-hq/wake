import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  parseEventEnvelope,
  parseIssueStateRecord,
  parseSourceStateRecord,
  parseWakeConfig,
  parseRunRecord,
  parseRunnerResultSentinel,
} from '../../src/domain/schema.js';
import type { WakeDevConfig, WakeSandboxConfig } from '../../src/domain/types.js';

describe('issue state schema', () => {
  it('accepts canonical issue and comment fields plus extensible context', () => {
    const record = parseIssueStateRecord({
      schemaVersion: 1,
      issue: {
        repo: 'atolis-hq/wake',
        number: 12,
        title: 'Example',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
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
});

describe('run and event schemas', () => {
  it('exports an explicit sandbox config helper type', () => {
    expectTypeOf<WakeSandboxConfig>().toEqualTypeOf<{
      image: string;
      containerName: string;
      containerMountPath: string;
      containerHomeMountPath: string;
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
      repo: 'atolis-hq/wake',
      issueNumber: 12,
      action: 'refine',
      status: 'running',
      startedAt: '2026-07-05T12:00:00.000Z',
    });

    expect(run.status).toBe('running');
  });

  it('accepts canonical event envelopes with work item correlation', () => {
    const event = parseEventEnvelope({
      schemaVersion: 1,
      eventId: 'evt-1',
      workItemKey: 'atolis-hq/wake#12',
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

    expect(event.workItemKey).toBe('atolis-hq/wake#12');
    expect(event.streamScope).toBe('work-item');
  });

  it('parses the sentinel from the last non-empty line only', () => {
    expect(parseRunnerResultSentinel('notes DONE more notes\nFAILED')).toBe('FAILED');
    expect(parseRunnerResultSentinel('notes DONE more notes\nDONE')).toBe('DONE');
  });

  it('does not match a sentinel word embedded in prose on the last line', () => {
    // Last line contains prose, not an exact sentinel — should fall back to FAILED
    expect(parseRunnerResultSentinel('notes DONE more notes FAILED')).toBe('FAILED');
    expect(parseRunnerResultSentinel('the previous run FAILED, so I re-ran the tests\nIf they had FAILED again it would be bad\nDONE. Finished.')).toBe('FAILED');
  });

  it('parses AWAITING_APPROVAL sentinel from last line', () => {
    expect(parseRunnerResultSentinel('Work complete, awaiting sign-off\nAWAITING_APPROVAL')).toBe('AWAITING_APPROVAL');
  });

  it('defaults to FAILED when no sentinel keyword is present on the last line', () => {
    expect(parseRunnerResultSentinel('Should I proceed with creating the worktree?')).toBe('FAILED');
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
    expect(config.sandbox.extraMounts).toEqual([
      {
        source: '/host/.claude/skills',
        target: '/home/wake/.claude/skills',
        readOnly: true,
      },
    ]);
  });

  it('accepts codex runner configuration', () => {
    const config = parseWakeConfig({
      schemaVersion: 1,
      paths: {
        wakeRoot: '/tmp/wake',
      },
      runner: {
        mode: 'codex',
        codex: {
          command: 'codex',
          model: 'gpt-5.5',
          smokeModel: 'gpt-5.4-mini',
          smokePrompt: 'hello',
          timeoutMs: 60_000,
        },
      },
    });

    expect(config.runner.mode).toBe('codex');
    expect(config.runner.codex.command).toBe('codex');
    expect(config.runner.codex.smokeModel).toBe('gpt-5.4-mini');
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
