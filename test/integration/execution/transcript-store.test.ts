import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TranscriptStore } from '../../../src/execution/index.js';

describe('TranscriptStore', () => {
  it('finalises a prompt and response into a CLI-scoped session group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);

    await store.capturePrompt({
      workItemId: 'work-1',
      runId: 'run/1',
      cli: 'codex cli',
      timestamp: '2026-08-12T10:00:00.000Z',
      text: 'Investigate the failure',
    });
    await store.captureResponse({
      workItemId: 'work-1',
      runId: 'run/1',
      cli: 'codex cli',
      sessionId: 'session/1',
      timestamp: '2026-08-12T10:01:00.000Z',
      text: 'Fixed it',
    });

    const [group] = await store.listGroups('work-1');
    expect(group).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^session--codex%20cli--[A-Za-z0-9_-]{43}$/),
        kind: 'session',
        cli: 'codex cli',
        latestAt: '2026-08-12T10:01:00.000Z',
        runIds: ['run/1'],
      }),
    );
    expect(group).toBeDefined();
    if (group === undefined) throw new Error('Expected transcript group');
    expect(await store.readGroup('work-1', group.id)).toEqual([
      {
        timestamp: '2026-08-12T10:00:00.000Z',
        runId: 'run/1',
        kind: 'prompt',
        text: 'Investigate the failure',
      },
      {
        timestamp: '2026-08-12T10:01:00.000Z',
        runId: 'run/1',
        kind: 'response',
        text: 'Fixed it',
      },
    ]);
  });

  it('finalises a conversation into a run group when no session is returned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);

    await store.capturePrompt({
      workItemId: 'work-1',
      runId: 'run/1',
      cli: 'claude',
      timestamp: '2026-08-12T10:00:00.000Z',
      text: 'Prompt',
    });
    await store.captureResponse({
      workItemId: 'work-1',
      runId: 'run/1',
      cli: 'claude',
      timestamp: '2026-08-12T10:01:00.000Z',
      text: 'Response',
    });

    expect(await store.groupForRun('work-1', 'run/1')).toBe('run--run%2F1');
    expect(await readdir(join(root, 'work-1'))).toEqual(['run--run%2F1']);
  });

  it('finalises a captured prompt into a fallback run group without adding a response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);

    await store.capturePrompt({
      workItemId: 'work-1',
      runId: 'run/1',
      cli: 'codex',
      timestamp: '2026-08-12T10:00:00.000Z',
      text: 'Prompt',
    });
    await store.finalisePrompt({
      workItemId: 'work-1',
      runId: 'run/1',
      cli: 'codex',
      timestamp: '2026-08-12T10:01:00.000Z',
    });

    expect(await readdir(join(root, 'work-1'))).toEqual(['run--run%2F1']);
    await expect(store.readGroup('work-1', 'run--run%2F1')).resolves.toEqual([
      {
        timestamp: '2026-08-12T10:00:00.000Z',
        runId: 'run/1',
        kind: 'prompt',
        text: 'Prompt',
      },
    ]);
  });

  it('keeps fallback runs whose identifiers need the same safe substitution in distinct groups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);

    for (const runId of ['run/a', 'run?a']) {
      await store.capturePrompt({
        workItemId: 'work-1',
        runId,
        cli: 'codex',
        timestamp: '2026-08-12T10:00:00.000Z',
        text: runId,
      });
      await store.captureResponse({
        workItemId: 'work-1',
        runId,
        cli: 'codex',
        timestamp: '2026-08-12T10:01:00.000Z',
        text: runId,
      });
    }

    expect(await store.listGroups('work-1')).toEqual([
      expect.objectContaining({
        id: 'run--run%2Fa',
        kind: 'run',
        latestAt: '2026-08-12T10:01:00.000Z',
        runIds: ['run/a'],
      }),
      expect.objectContaining({
        id: 'run--run%3Fa',
        kind: 'run',
        latestAt: '2026-08-12T10:01:00.000Z',
        runIds: ['run?a'],
      }),
    ]);
  });

  it('keeps a trailing-dot run identity distinct on Windows filesystems', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);

    for (const runId of ['run', 'run.']) {
      await store.captureResponse({
        workItemId: 'work-1',
        runId,
        cli: 'codex',
        timestamp: '2026-08-12T10:00:00.000Z',
        text: runId,
      });
    }

    expect(await store.listGroups('work-1')).toEqual([
      expect.objectContaining({
        id: 'run--run',
        kind: 'run',
        latestAt: '2026-08-12T10:00:00.000Z',
        runIds: ['run'],
      }),
      expect.objectContaining({
        id: 'run--run%2E',
        kind: 'run',
        latestAt: '2026-08-12T10:00:00.000Z',
        runIds: ['run.'],
      }),
    ]);
  });

  it('keeps pending prompts distinct when one run ID has a trailing dot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);

    for (const runId of ['run', 'run.']) {
      await store.capturePrompt({
        workItemId: 'work-1',
        runId,
        cli: 'codex',
        timestamp: '2026-08-12T10:00:00.000Z',
        text: `prompt for ${runId}`,
      });
    }

    expect(await readdir(join(root, 'work-1'))).toEqual(['.pending--run', '.pending--run%2E']);

    for (const runId of ['run', 'run.']) {
      await store.captureResponse({
        workItemId: 'work-1',
        runId,
        cli: 'codex',
        timestamp: '2026-08-12T10:01:00.000Z',
        text: `response for ${runId}`,
      });
    }

    await expect(store.readGroup('work-1', 'run--run')).resolves.toContainEqual({
      timestamp: '2026-08-12T10:00:00.000Z',
      runId: 'run',
      kind: 'prompt',
      text: 'prompt for run',
    });
    await expect(store.readGroup('work-1', 'run--run%2E')).resolves.toContainEqual({
      timestamp: '2026-08-12T10:00:00.000Z',
      runId: 'run.',
      kind: 'prompt',
      text: 'prompt for run.',
    });
  });

  it('keeps session groups distinct when CLI and session IDs contain group delimiters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);

    await store.captureResponse({
      workItemId: 'work-1',
      runId: 'run-1',
      cli: 'a--b',
      sessionId: 'c',
      timestamp: '2026-08-12T10:00:00.000Z',
      text: 'first',
    });
    await store.captureResponse({
      workItemId: 'work-1',
      runId: 'run-2',
      cli: 'a',
      sessionId: 'b--c',
      timestamp: '2026-08-12T10:01:00.000Z',
      text: 'second',
    });

    const groups = await store.listGroups('work-1');
    expect(groups).toHaveLength(2);
    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^session--a--[A-Za-z0-9_-]{43}$/),
          kind: 'session',
          cli: 'a',
          latestAt: '2026-08-12T10:01:00.000Z',
          runIds: ['run-2'],
        }),
        expect.objectContaining({
          id: expect.stringMatching(/^session--a%2D%2Db--[A-Za-z0-9_-]{43}$/),
          kind: 'session',
          cli: 'a--b',
          latestAt: '2026-08-12T10:00:00.000Z',
          runIds: ['run-1'],
        }),
      ]),
    );
    expect(new Set(groups.map((group) => group.id))).toHaveLength(2);
  });

  it('reads messages in timestamp order rather than filesystem modification time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);

    await store.capturePrompt({
      workItemId: 'work-1',
      runId: 'run-1',
      cli: 'codex',
      timestamp: '2026-08-12T10:02:00.000Z',
      text: 'Later',
    });
    await store.captureResponse({
      workItemId: 'work-1',
      runId: 'run-1',
      cli: 'codex',
      timestamp: '2026-08-12T10:01:00.000Z',
      text: 'Earlier',
    });

    expect(
      (await store.readGroup('work-1', 'run--run%2D1')).map((message) => message.text),
    ).toEqual(['Earlier', 'Later']);
  });

  it('marks a work item for expiry and removes it only after the retention interval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);
    await store.capturePrompt({
      workItemId: 'work-1',
      runId: 'run-1',
      cli: 'codex',
      timestamp: '2026-08-12T10:00:00.000Z',
      text: 'Prompt',
    });

    await store.markWorkItemCleaned('work-1', 1_000, '2026-08-12T10:00:00.000Z');
    expect(await readFile(join(root, 'work-1', '.cleaned-at'), 'utf8')).toBe(
      '2026-08-12T10:00:00.000Z',
    );
    await expect(store.sweepExpired(1_000, '2026-08-12T10:00:00.999Z')).resolves.toEqual([]);
    await expect(store.sweepExpired(1_000, '2026-08-12T10:00:01.000Z')).resolves.toEqual([
      'work-1',
    ]);
    await expect(store.listGroups('work-1')).resolves.toEqual([]);
  });

  it('deletes a work item immediately when cleaned with zero retention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const store = new TranscriptStore(root);
    await store.capturePrompt({
      workItemId: 'work-1',
      runId: 'run-1',
      cli: 'codex',
      timestamp: '2026-08-12T10:00:00.000Z',
      text: 'Prompt',
    });

    await store.markWorkItemCleaned('work-1', 0, '2026-08-12T10:00:00.000Z');

    await expect(store.listGroups('work-1')).resolves.toEqual([]);
  });

  it('continues sweeping later marked work items after a transcript filesystem failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-store-'));
    const failedDirectory = join(root, 'work-failed');
    const store = new TranscriptStore(root, {
      async remove(path, options) {
        if (path === failedDirectory) throw new Error('locked');
        await rm(path, options);
      },
    });
    const failures: string[] = [];
    for (const workItemId of ['work-failed', 'work-reclaimed']) {
      await store.capturePrompt({
        workItemId,
        runId: 'run-1',
        cli: 'codex',
        timestamp: '2026-08-12T10:00:00.000Z',
        text: 'Prompt',
      });
      await store.markWorkItemCleaned(workItemId, 1_000, '2026-08-12T10:00:00.000Z');
    }

    await expect(
      store.sweepExpired(1_000, '2026-08-12T10:00:01.000Z', (workItemId, error) =>
        failures.push(`${workItemId}:${error instanceof Error ? error.message : String(error)}`),
      ),
    ).resolves.toEqual(['work-reclaimed']);
    expect(failures).toEqual(['work-failed:locked']);
    await expect(readFile(join(root, 'work-failed', '.cleaned-at'), 'utf8')).resolves.toBe(
      '2026-08-12T10:00:00.000Z',
    );
    await expect(store.listGroups('work-reclaimed')).resolves.toEqual([]);
  });
});
