import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { transcriptGroups, readWorkTranscript } from '../../../src/bootstrap/surface-api-transcripts.js';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { TranscriptStore, type RunView } from '../../../src/execution/index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('surface transcript applications', () => {
  it('indexes opaque session groups and reads ordered entries with durable run duration', async () => {
    const store = new TranscriptStore(await transcriptRoot());
    await store.capturePrompt({
      workItemId: 'work-1',
      runId: 'run-1',
      cli: 'codex',
      timestamp: '2026-08-13T10:00:01.000Z',
      text: 'first input',
    });
    await store.captureResponse({
      workItemId: 'work-1',
      runId: 'run-1',
      cli: 'codex',
      sessionId: 'provider-session-secret',
      timestamp: '2026-08-13T10:00:03.000Z',
      text: 'first output',
    });
    const [group] = await transcriptGroups(store, 'work-1');
    if (group === undefined) throw new Error('Expected transcript group');

    expect(group).toMatchObject({
      kind: 'session',
      cli: 'codex',
      latestAt: '2026-08-13T10:00:03.000Z',
      runIds: ['run-1'],
    });
    expect(group.groupId).not.toContain('provider-session-secret');

    const conversation = await readWorkTranscript(store, 'work-1', group.groupId, [
      run('run-1', '2026-08-13T10:00:00.000Z', '2026-08-13T10:00:05.000Z'),
    ]);

    expect(conversation).toMatchObject({
      groupId: group.groupId,
      available: true,
      entries: [
        { channel: 'input', text: 'first input', runId: 'run-1', durationMs: 5_000 },
        { channel: 'agent', text: 'first output', runId: 'run-1', durationMs: 5_000 },
      ],
    });
  });

  it('does not read a group whose captured runs do not belong to the requested work item', async () => {
    const store = new TranscriptStore(await transcriptRoot());
    await store.capturePrompt({
      workItemId: 'work-1',
      runId: 'foreign-run',
      cli: 'codex',
      timestamp: '2026-08-13T10:00:01.000Z',
      text: 'foreign input',
    });
    await store.captureResponse({
      workItemId: 'work-1',
      runId: 'foreign-run',
      cli: 'codex',
      timestamp: '2026-08-13T10:00:02.000Z',
      text: 'foreign output',
    });
    const [group] = await transcriptGroups(store, 'work-1');
    if (group === undefined) throw new Error('Expected transcript group');

    await expect(readWorkTranscript(store, 'work-1', group.groupId, [])).resolves.toBeUndefined();
  });

});

async function transcriptRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-api-transcripts-'));
  temporaryRoots.push(root);
  return root;
}

function run(runId: string, startedAt: string, finishedAt: string): RunView {
  return { runId, startedAt, finishedAt } as RunView;
}
