import {
  FileCheckpointStore,
  FileEventJournal,
  FileProcessorStateStore,
  FileProjectionStore,
  createFileProcessorRunSerialiser,
} from '@atolis-hq/eventing-filesystem';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventingAdapterContract } from '../../../test/contracts/eventing-adapter-contract.js';

eventingAdapterContract('filesystem', {
  async create(clock) {
    const root = await mkdtemp(join(tmpdir(), 'wake-eventing-contract-'));
    const journal = new FileEventJournal(root, clock);
    return {
      journal,
      checkpoints: new FileCheckpointStore(root),
      projections: new FileProjectionStore(root, {
        protectedProcessorStateConsumers: ['consumer:projection-rebuild'],
      }),
      processorState: new FileProcessorStateStore(root),
      serialiseRun: createFileProcessorRunSerialiser(root),
      async flatRecordCompatibility() {
        await mkdir(join(root, 'events'), { recursive: true });
        await writeFile(
          join(root, 'events', '2026-08-31.jsonl'),
          `${JSON.stringify({
            eventId: 'flat-event-1',
            eventType: 'contract.created',
            schemaVersion: 1,
            occurredAt: '2026-08-31T12:00:00.000Z',
            correlationId: 'correlation-1',
            causationId: 'causation-1',
            actor: { kind: 'system', id: 'contract' },
            source: { kind: 'internal', id: 'contract' },
            stream: { kind: 'contract', id: 'one' },
            payload: { value: 1 },
            recordedAt: '2026-08-31T12:30:00.000Z',
            sequence: 1,
            globalPosition: 1,
          })}\n`,
        );
        return journal.readAll(0);
      },
      async dispose() {
        await rm(root, { recursive: true, force: true });
      },
    };
  },
});
