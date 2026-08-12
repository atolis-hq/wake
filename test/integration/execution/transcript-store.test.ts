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
        id: 'session--codex-cli--session-1',
        kind: 'session',
        runIds: ['run/1'],
      },
    ]);
    expect(await store.readGroup('work-1', 'session--codex-cli--session-1')).toEqual([
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

    expect(await store.groupForRun('work-1', 'run/1')).toBe('run--run-1');
    expect(await readdir(join(root, 'work-1'))).toEqual(['run--run-1']);
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

    expect((await store.readGroup('work-1', 'run--run-1')).map((message) => message.text)).toEqual([
      'Earlier',
      'Later',
    ]);
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
