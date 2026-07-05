import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createTickRunner } from '../../src/core/tick-runner.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  it('writes a running run record before invoking the runner', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runFileSnapshot = '';

    const runner = {
      async run() {
        const runFiles = await readdir(join(root, 'runs'));
        runFileSnapshot = await readFile(join(root, 'runs', runFiles[0]!), 'utf8');
        return { result: 'Runner output\nDONE', session_id: 'session-1' };
      },
    };

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config: createDefaultWakeConfig(root),
      stateStore: store,
      workSource: createFakeTicketingSystem({
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 9,
            title: 'Implement',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
      }),
      runner,
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    expect(runFileSnapshot).toContain('"status": "running"');
  });

  it('creates event audit records for sync and completion', async () => {
    const store = createStateStore({ wakeRoot: root });
    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config: createDefaultWakeConfig(root),
      stateStore: store,
      workSource: createFakeTicketingSystem({
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 10,
            title: 'Refine',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
      }),
      runner: {
        async run() {
          return { result: 'Fake runner completed\nDONE', session_id: 'fake-session-1' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    expect(events).toContain('"sourceEventType":"fake.issue.upsert"');
    expect(events).toContain('"sourceEventType":"wake.run.completed"');
  });

  it('persists outbound publish intents before sink delivery', async () => {
    const store = createStateStore({ wakeRoot: root });
    const ticketingSystem = createFakeTicketingSystem({
      tickets: [
        {
          repo: 'atolis-hq/wake',
          number: 11,
          title: 'Clarify',
          body: 'Body',
          labels: ['wake:queue'],
          comments: [],
        },
      ],
      now: () => new Date('2026-07-05T12:00:00.000Z'),
    });

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config: createDefaultWakeConfig(root),
      stateStore: store,
      workSource: ticketingSystem,
      outboundSink: ticketingSystem,
      runner: {
        async run() {
          return {
            result: 'Question for the owner\nBLOCKED',
            session_id: 'fake-session-2',
          };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    expect(events).toContain('"sourceEventType":"wake.publish.intent.requested"');
    expect(events).toContain('"sourceEventType":"fake.issue.comment.published"');
  });
});
