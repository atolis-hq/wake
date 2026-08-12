import { mkdtemp, readdir, readFile } from 'node:fs/promises';
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

    expect(await store.listGroups('work-1')).toEqual([
      {
        id: 'session--codex%20cli--session%2F1',
        kind: 'session',
        runIds: ['run/1'],
      },
    ]);
    expect(await store.readGroup('work-1', 'session--codex%20cli--session%2F1')).toEqual([
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
      { id: 'run--run%2Fa', kind: 'run', runIds: ['run/a'] },
      { id: 'run--run%3Fa', kind: 'run', runIds: ['run?a'] },
    ]);
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

    expect(await store.listGroups('work-1')).toEqual([
      { id: 'session--a--b%2D%2Dc', kind: 'session', runIds: ['run-2'] },
      { id: 'session--a%2D%2Db--c', kind: 'session', runIds: ['run-1'] },
    ]);
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
});
