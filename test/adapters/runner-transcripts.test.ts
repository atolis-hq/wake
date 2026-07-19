import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeRunnerTranscript } from '../../src/adapters/runner/transcripts.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';

describe('runner transcripts', () => {
  const projection = {
    schemaVersion: 1 as const,
    workItemKey: 'work-01JZ0000000000000000000223',
    origin: 'github',
    issue: {
      repo: 'atolis-hq/wake',
      number: 223,
      title: 'Log prompts',
      body: 'Body',
      labels: [],
      assignees: [],
      isPullRequest: false,
      state: 'open' as const,
      url: 'https://example.test/issues/223',
      createdAt: '2026-07-12T12:00:00.000Z',
      updatedAt: '2026-07-12T12:00:00.000Z',
    },
    comments: [],
    wake: {
      stage: 'implement' as const,
      syncedAt: '2026-07-12T12:00:00.000Z',
      stageHistory: [],
      recentEventIds: [],
      expectedEcho: { commentIds: [], labels: [] },
    },
    context: {},
    correlatedResources: [],
  };

  it('does nothing when transcript logging is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcripts-'));
    const config = createDefaultWakeConfig(root);

    const file = await writeRunnerTranscript({
      config,
      projection,
      runId: 'run-223-1',
      action: 'implement',
      cli: 'Codex',
      kind: 'prompt',
      text: 'raw prompt',
    });

    expect(file).toBeUndefined();
  });

  it('stores raw prompt text under the work id and session folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcripts-'));
    const config = createDefaultWakeConfig(root);
    config.transcripts.enabled = true;

    const file = await writeRunnerTranscript({
      config,
      projection,
      runId: 'run-223-1',
      action: 'implement',
      cli: 'Codex',
      kind: 'prompt',
      text: 'raw prompt\nexactly as sent',
    });

    expect(file).toBe(
      join(
        root,
        'transcripts',
        'work-01JZ0000000000000000000223',
        'run-223-1',
        'run-223-1.codex.implement.prompt.txt',
      ),
    );
    await expect(readFile(file!, 'utf8')).resolves.toBe('raw prompt\nexactly as sent');
  });

  it('groups resumed runs under the stored agent session id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcripts-'));
    const config = createDefaultWakeConfig(root);
    config.transcripts.enabled = true;

    const file = await writeRunnerTranscript({
      config,
      projection: {
        ...projection,
        wake: {
          ...projection.wake,
          sessionId: 'session:abc/123',
          sessionCli: 'Cursor',
        },
      },
      runId: 'run-223-2',
      action: 'implement',
      cli: 'Cursor',
      kind: 'response',
      text: 'raw response',
    });

    expect(file).toBe(
      join(
        root,
        'transcripts',
        'work-01JZ0000000000000000000223',
        'session__abc__123',
        'run-223-2.cursor.implement.response.txt',
      ),
    );
    await expect(readFile(file!, 'utf8')).resolves.toBe('raw response');
  });
});
