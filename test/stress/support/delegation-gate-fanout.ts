import { correlationId } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { DelegationGate } from '../../../src/orchestration/application/delegation-gate.js';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

// Runs in a child with a deliberately small heap: a journal with thousands of
// segment files and hundreds of delegated instances, gated as one tick does.
const [root, segments, instances] = [
  process.argv[2]!,
  Number(process.argv[3]),
  Number(process.argv[4]),
];
const context = (seed: string) => ({
  commandId: `cmd-${seed}`,
  correlationId: correlationId(`corr-${seed}`),
  occurredAt: '2026-07-30T12:00:00Z',
  actor: { kind: 'operator' as const, id: 'stress' },
});

const writer = createWorkService(new FileEventJournal(root, new FakeClock()));
const rootId = workId('root');
await writer.create({ workItemId: rootId, objective: 'root' }, context('root'));
const ids = Array.from({ length: instances }, (_, index) => workId(`child-${index}`));
for (const [index, id] of ids.entries())
  await writer.create(
    {
      workItemId: id,
      objective: `child ${index}`,
      delegation: { parentWorkItemId: rootId, rootWorkItemId: rootId, ancestors: [rootId] },
    },
    context(`child-${index}`),
  );
// Pad history with unrelated segments so a listing costs what it does in production.
for (let index = instances + 1; index < segments; index += 1)
  await writer.create(
    { workItemId: workId(`pad-${index}`), objective: 'pad' },
    context(`pad-${index}`),
  );

const reader = createWorkService(new FileEventJournal(root, new FakeClock()));
const gate = new DelegationGate({} as never, reader);
const views = ids.map((workItemId) => ({ workItemId })) as WorkflowInstanceView[];
const open = await gate.filterAvailable(views, (view) => view);
if (open.length !== instances) throw new Error(`expected ${instances} open, got ${open.length}`);
console.log('ok');
