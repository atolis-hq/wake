import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { integrationStream } from '../../../../src/integrations/contracts/streams.js';
import { createGitHubEventData } from '../../../../src/integrations/github/contracts/event-factory.js';
import { GitHubEventType } from '../../../../src/integrations/github/contracts/events.js';
import { GitHubAdapter } from '../../../../src/integrations/github/contracts/vocabulary.js';
import { consecutivePullRequestObservations } from '../../../../src/integrations/github/infrastructure/consecutive-pr-observations.js';
import { FakeClock } from '../../../e2e/support/world.js';

function observation(key: string, eventId: string, causationId: string, kind = 'pull-request') {
  return createGitHubEventData({
    eventId,
    eventType: GitHubEventType.WorkObserved,
    occurredAt: '2026-08-16T19:22:00.000Z',
    correlationId: `github:${key}`,
    causationId,
    actor: { kind: 'integration', id: 'github' },
    source: { kind: 'adapter', id: 'github' },
    payload: {
      externalKey: key,
      kind: kind as 'pull-request',
      title: 't',
      body: '',
      state: 'open',
      revision: 'r',
      actor: { id: 'a', kind: 'human' },
      raw: {},
    } as never,
  });
}

// The integration stream grows without bound; PR de-duplication must not read it.
it('chains and drops consecutive PR observations without reading the stream', async () => {
  const journal = new FileEventJournal(
    await mkdtemp(join(tmpdir(), 'wake-consecutive-')),
    new FakeClock(),
  );
  const stream = integrationStream(GitHubAdapter);
  await journal.appendToStream(stream, 0, [
    observation('o/r#1', 'pr1-a', 'cause-a'),
    observation('o/r#2', 'pr2-a', 'cause-x'),
    ...Array.from({ length: 120 }, (_, index) =>
      observation('o/r#1', `noise-${index}`, `noise-${index}`, 'issue'),
    ),
  ]);
  const readStream = vi.spyOn(journal, 'readStream');

  const same = await consecutivePullRequestObservations(
    [observation('o/r#1', 'pr1-b', 'cause-a')],
    journal,
    undefined,
  );
  const changed = await consecutivePullRequestObservations(
    [observation('o/r#1', 'pr1-c', 'cause-b'), observation('o/r#3', 'pr3-a', 'cause-y')],
    journal,
    undefined,
  );
  const issuesOnly = await consecutivePullRequestObservations(
    [observation('o/r#9', 'issue-9', 'cause-i', 'issue')],
    journal,
    undefined,
  );

  expect(same).toEqual([]);
  expect(changed.map((draft) => draft.eventId)).toEqual([
    expect.stringMatching(/^pr1-c:[0-9a-f]{64}$/),
    expect.stringMatching(/^pr3-a:[0-9a-f]{64}$/),
  ]);
  expect(issuesOnly).toHaveLength(1);
  expect(readStream).not.toHaveBeenCalled();
});
