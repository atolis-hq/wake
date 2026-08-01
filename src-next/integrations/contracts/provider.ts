import type { ExternalDeliveryAdapter } from '../delivery/contracts/config.js';
import { adapterId, type AdapterId } from './identifiers.js';
import type { IntegrationsConfig } from './config.js';
import type { ExternalEventSource, InboundTranslation } from './intake.js';
import type { Clock, IdGenerator } from '../../kernel/index.js';
import type { ResourceService } from '../../resources/index.js';
import type { WorkService } from '../../work/index.js';
import type {
  OrchestrationService,
  WorkflowCandidate,
  WorkflowName,
} from '../../orchestration/index.js';
import type { PullRequestService } from '../../activities/index.js';

// Configuration decides routing; providers supply facts. An adapter can ask which
// workflow a candidate belongs to, but never proposes a workflow name.
export interface WorkflowRouter {
  select(candidate: WorkflowCandidate): WorkflowName;
}

export interface ProviderServices {
  readonly work: WorkService;
  readonly resources: ResourceService;
  readonly orchestration: OrchestrationService;
  readonly pullRequests: PullRequestService;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly journal: import('../../kernel/index.js').EventJournal;
  readonly checkpoints: import('../../kernel/index.js').CheckpointStore;
  readonly routing: WorkflowRouter;
}

export interface ProviderInstance {
  readonly adapter: AdapterId;
  readonly source: ExternalEventSource;
  readonly delivery: ExternalDeliveryAdapter;
  readonly inbound: InboundTranslation;
  readonly eventTypes: readonly string[];
}

export interface ProviderDefinition<Config = unknown> {
  readonly provider: string;
  readonly eventTypes: readonly string[];
  parseConfig(value: unknown): Config;
  create(input: {
    readonly adapter: AdapterId;
    readonly config: Config;
    readonly services?: ProviderServices;
  }): ProviderInstance;
}

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();

  register(definition: ProviderDefinition): void {
    if (this.definitions.has(definition.provider))
      throw new Error(`Provider ${definition.provider} exists`);
    this.definitions.set(definition.provider, definition);
  }

  compose(config: IntegrationsConfig, services?: ProviderServices): readonly ProviderInstance[] {
    return Object.entries(config).flatMap(([name, entry]) => {
      if (!entry.enabled) return [];
      const provider = entry.provider ?? name;
      const definition = this.definitions.get(provider);
      if (definition === undefined) throw new Error(`Provider ${provider} is not registered`);
      return [
        definition.create({
          adapter: adapterId(name),
          config: definition.parseConfig(entry),
          ...(services === undefined ? {} : { services }),
        }),
      ];
    });
  }
}
