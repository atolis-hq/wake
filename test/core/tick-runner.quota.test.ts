import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import { findByIssueRef } from './support/tick-runner-fixtures.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  describe('quota & routing', () => {
    it('stamps resolved runner routing into run records and completion events', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: createFakeTicketingSystem({
          tickets: [
            {
              repo: 'atolis-hq/wake',
              number: 110,
              title: 'Route stamp',
              body: 'Body',
              labels: ['wake:queue'],
              comments: [],
            },
          ],
          now: () => new Date('2026-07-05T12:00:00.000Z'),
        }),
        runner: {
          async run() {
            return {
              result: 'Fake runner completed\nDONE',
              model: 'test-model',
              cli: 'test-cli',
              routing: {
                runnerName: 'fake-light',
                runnerKind: 'fake',
                tier: 'light',
                reason: 'stage queue tier light selected runner fake-light',
              },
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const [runRecord] = await store.listRunRecords();
      expect(runRecord?.routing).toEqual({
        runnerName: 'fake-light',
        runnerKind: 'fake',
        tier: 'light',
        reason: 'stage queue tier light selected runner fake-light',
      });

      const events = await readFile(store.paths.eventFile('2026-07-05'), 'utf8');
      expect(events).toContain(
        '"routing":{"runnerName":"fake-light","runnerKind":"fake","tier":"light"',
      );
    });

    it('pauses until the reported quota reset and suppresses quota failure comments', async () => {
      const store = createStateStore({ wakeRoot: root });
      const publishedKinds: string[] = [];
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-07T22:30:00.000Z') },
        config,
        stateStore: store,
        workSource: createFakeTicketingSystem({
          tickets: [
            {
              repo: 'atolis-hq/wake',
              number: 112,
              title: 'Quota pause',
              body: '',
              labels: ['wake:queue'],
              comments: [],
            },
          ],
        }),
        outboundSink: {
          async deliverIntent({ event }) {
            if (event.sourceEventType === 'wake.publish.intent.requested') {
              publishedKinds.push(String(event.payload.kind));
            }
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result:
                "Claude runner failed: You've hit your session limit - resets 1:10am (UTC)\nFAILED",
              model: 'test-model',
              cli: 'Claude',
              failureClass: 'quota' as const,
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      expect(await store.readLedger()).toMatchObject({
        runners: {
          fake: {
            pausedUntil: '2026-07-08T01:10:00.000Z',
            failureCount: 1,
          },
        },
      });
      expect(publishedKinds).toEqual([]);
      const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 112 });
      expect(projection?.context.lastFailureClass).toBe('quota');
    });
  });
});
