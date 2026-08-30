import type { PullRequestService } from '../../activities/index.js';
import type { ConversationService } from '../../conversations/index.js';
import type { RunRepository } from '../../execution/index.js';
import type { CheckpointStore, Clock, EventJournal, IdGenerator } from '../../kernel/index.js';
import type {
  OrchestrationService,
  WorkflowCandidate,
  WorkflowName,
} from '../../orchestration/index.js';
import type {
  ExternalResourceKey,
  ResourceCapability,
  ResourceKind,
  ResourceLookup,
  ResourceService,
} from '../../resources/index.js';
import type { WorkItemId, WorkItemView, WorkService } from '../../work/index.js';
import type { ExternalDeliveryAdapter } from '../delivery/contracts/config.js';
import type { ArtifactVerificationResult } from './artifact-vocabulary.js';
import type { IntegrationsConfig } from './config.js';
import { adapterId, type AdapterId } from './identifiers.js';
import type { ExternalEventSource, InboundTranslation, ProviderReconciler } from './intake.js';
import type { ReplyPublicationConfig } from './reply-routing.js';

// Configuration decides routing; providers supply facts. An adapter can ask which
// workflow a candidate belongs to, but never proposes a workflow name.
export interface WorkflowRouter {
  select(candidate: WorkflowCandidate): WorkflowName;
}

// Structurally matches control-plane's WorkConclusionPolicy without importing
// it — integrations may not depend on control-plane (dependency-cruiser.config.mjs).
// bootstrap/composition-root.ts supplies the real cascade; this is the shape it must satisfy.
export interface WorkConclusion {
  closeWork(workItemId: WorkItemId, reason: string): Promise<WorkItemView>;
  cancelWork(workItemId: WorkItemId, reason: string): Promise<WorkItemView>;
}

export interface ProviderServices {
  /** Stable operator-configured UI address included in provider notifications when present. */
  readonly publicUiUrl?: string | undefined;
  readonly work: WorkService;
  readonly conversations: ConversationService;
  readonly resources: ResourceService;
  readonly resourceLookup: ResourceLookup;
  readonly orchestration: OrchestrationService;
  readonly pullRequests: PullRequestService;
  readonly runs: RunRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly journal: EventJournal;
  readonly checkpoints: CheckpointStore;
  readonly routing: WorkflowRouter;
  readonly conclusion: WorkConclusion;
}

export interface VerifiedArtifact {
  readonly kind: ResourceKind;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string | undefined;
}

// Health of one adapter-defined slice of its own traffic. scope and channel are
// entirely adapter-owned (e.g. GitHub scopes by repository, with 'poll'/'deliver'
// channels); callers attach adapter/provider identity from the owning ProviderInstance.
export interface AdapterHealthCheck {
  readonly scope: string;
  readonly channel: string;
  readonly status: 'ok' | 'degraded';
  readonly detail?: string;
  readonly successCount: number;
  readonly failureCount: number;
}

// A command/action an adapter recognizes from its channel (e.g. a GitHub
// comment reply). Syntax only, no description — surfaces present these
// verbatim rather than hardcoding per-adapter command lists.
export interface AdapterCommand {
  readonly syntax: string;
}

export interface ProviderInstance {
  readonly adapter: AdapterId;
  // Provider type this instance was composed from (e.g. 'github'), stamped by
  // ProviderRegistry.compose() — distinct from `adapter`, the operator-chosen config key.
  readonly provider: string;
  readonly source: ExternalEventSource;
  readonly delivery: ExternalDeliveryAdapter;
  readonly inbound: InboundTranslation;
  /** Provider-owned recovery, called in the maintenance lane. */
  readonly reconciler?: ProviderReconciler;
  readonly eventTypes: readonly string[];
  /** Provider-owned periodic reconciliation, invoked in the tick react phase. */
  readonly maintenance?: { readonly runOnce: () => Promise<void> };
  verifyArtifact(
    kind: ResourceKind,
    externalKey: ExternalResourceKey,
    context: { readonly workspaceBranch: string },
  ): Promise<VerifiedArtifact | ArtifactVerificationResult>;
  // Optional live reachability probe a caller (e.g. doctor diagnostics) can invoke
  // generically; resolves when the external system is reachable, rejects otherwise.
  readonly checkConnectivity?: () => Promise<void>;
  // Optional in-memory health signal tracked from real traffic, synchronous and
  // cheap to call on every health check — no I/O, no stored per-call history.
  readonly health?: () => readonly AdapterHealthCheck[];
  // Optional list of commands this adapter recognizes, built-in plus any
  // configuration-defined additions. Synchronous and cheap, like health().
  readonly commands?: () => readonly AdapterCommand[];
  readonly replyPublication?: ReplyPublicationConfig | undefined;
}

// What a definition's create() builds, before ProviderRegistry.compose() stamps
// on `provider` — the definition already declares its own provider type statically,
// so create() implementations don't repeat it.
export type ComposedProviderInstance = Omit<ProviderInstance, 'provider'>;

export interface ProviderDefinition<Config = unknown> {
  readonly provider: string;
  readonly eventTypes: readonly string[];
  /** Provider-owned periodic reconciliation, invoked in the tick react phase. */
  readonly maintenance?: { readonly runOnce: () => Promise<void> };
  parseConfig(value: unknown): Config;
  create(input: {
    readonly adapter: AdapterId;
    readonly config: Config;
    readonly services?: ProviderServices;
  }): ComposedProviderInstance;
}

// A provider that fails to construct (bad config, unreachable credentials —
// e.g. sandbox auth not configured yet) must not take composition down with
// it: every other command (doctor, sandbox-setup, sandbox-entrypoint) still
// needs to run. An adapter naming a provider Wake doesn't know about at all
// is a different, unrecoverable class of error and still throws.
export interface ProviderCompositionFailure {
  readonly adapter: AdapterId;
  readonly provider: string;
  readonly error: string;
}

export interface ProviderCompositionResult {
  readonly instances: readonly ProviderInstance[];
  readonly failures: readonly ProviderCompositionFailure[];
}

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();

  register(definition: ProviderDefinition): void {
    if (this.definitions.has(definition.provider))
      throw new Error(`Provider ${definition.provider} exists`);
    this.definitions.set(definition.provider, definition);
  }

  compose(config: IntegrationsConfig, services?: ProviderServices): ProviderCompositionResult {
    const instances: ProviderInstance[] = [];
    const failures: ProviderCompositionFailure[] = [];
    for (const [name, entry] of Object.entries(config)) {
      if (!entry.enabled) continue;
      const provider = entry.provider ?? name;
      const definition = this.definitions.get(provider);
      if (definition === undefined) throw new Error(`Provider ${provider} is not registered`);
      const adapter = adapterId(name);
      try {
        instances.push({
          ...definition.create({
            adapter,
            config: definition.parseConfig(entry),
            ...(services === undefined ? {} : { services }),
          }),
          provider,
        });
      } catch (error) {
        failures.push({
          adapter,
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { instances, failures };
  }
}
