import type {
  EventEnvelope,
  EventJournal,
  ProcessorRunSerialiser,
  ProcessorStateStore,
} from '@atolis-hq/eventing';
import type { IdGenerator } from '../../kernel/index.js';
import type { TriggerConfig } from '../contracts/config.js';
import type { TriggerInvocationView } from './trigger-projection.js';
import type { TriggerCheckpointStore } from './trigger-source-cursor.js';
import type { TriggerWorkflowPorts } from './trigger-workflow.js';

export interface TriggerServiceDependencies extends TriggerWorkflowPorts {
  readonly checkpoint: TriggerCheckpointStore;
  readonly journal: EventJournal;
  readonly state: ProcessorStateStore;
  readonly history: () => Promise<readonly TriggerInvocationView[]>;
  readonly invocationScope: (workItemId: string) => Promise<string | null>;
  readonly serialise: ProcessorRunSerialiser;
  readonly ids: IdGenerator;
  readonly configurations: () => readonly TriggerConfig[];
  readonly coordinationKey?: (config: TriggerConfig) => string;
  readonly sourceWorkItem: (event: EventEnvelope) => Promise<string | null>;
  readonly isDispatchPaused: () => Promise<boolean>;
  readonly capacityAvailable: (config: TriggerConfig) => Promise<boolean>;
  readonly now: () => string;
}
