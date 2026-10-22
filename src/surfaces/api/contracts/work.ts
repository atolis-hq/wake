import type { RunResponse, TranscriptGroupResponse } from './execution.js';
import type { WorkflowInstanceResponse } from './orchestration.js';
import type { ResourceItemResponse } from './resources.js';

/** A WorkItemKey is Wake's opaque, canonical work-item route identity. */
export type WorkItemKey = string;

export interface WorkItemResponse {
  readonly workItemKey: WorkItemKey;
  readonly workItemId: string;
  readonly objective: string;
  readonly state: string;
  readonly frozen?: boolean;
  readonly deleted?: boolean;
  readonly relatedWorkItems: readonly {
    readonly workItemKey: WorkItemKey;
    readonly relation: string;
  }[];
  readonly externalRef?: string;
  /** Raw outcome emitted by the latest agent run, when one is available. */
  readonly lastRunOutcome?: string;
}

/** Governed integration progress, derived from provider-observed state; never a separate record. */
export interface DeliveryIntegrationResponse {
  readonly complete: boolean;
  readonly summary: string;
  readonly targets: readonly {
    /** The child that owns the pull request; integration never transfers ownership. */
    readonly workItemKey: WorkItemKey;
    readonly outputName: string;
    readonly state: string;
    readonly layer: number;
    readonly baseMovement: string;
    readonly evidenceAffected: boolean;
    readonly maintenance?: string;
    readonly detail?: string;
  }[];
  readonly maintenance: readonly {
    readonly maintenanceId: string;
    readonly workItemKey: WorkItemKey;
    readonly outputName: string;
    readonly kind: string;
    readonly previousRevision: string;
    readonly currentRevision: string;
    readonly producerRunId: string;
  }[];
}

export interface DeliveryQaResponse {
  readonly integration?: DeliveryIntegrationResponse;
  readonly selectionRevision: number;
  readonly candidateId?: string;
  readonly repositories: readonly { readonly resourceId: string; readonly revision: string }[];
  readonly stale: readonly string[];
  /** Why each stale selected output no longer counts as current evidence. */
  readonly staleOutputs?: readonly {
    readonly workItemKey: WorkItemKey;
    readonly outputName: string;
    readonly reason: string;
  }[];
  readonly verdict?: string;
  readonly effective: boolean;
  readonly canComplete: boolean;
  readonly reason?: string;
  readonly exhausted: boolean;
  readonly findings: readonly string[];
}

export interface WorkDetailResponse {
  readonly delegation?: {
    readonly qa?: DeliveryQaResponse;
    readonly rootWorkItemKey: WorkItemKey;
    readonly parentWorkItemKey?: WorkItemKey;
    /** Present while the parent is waiting on an assessment of blocked children. */
    readonly attention?: {
      readonly cohortId: string;
      readonly revision: number;
      readonly blockers: readonly {
        readonly blockerId: string;
        readonly workItemKey: WorkItemKey;
        readonly kind: string;
        readonly reason: string;
        /** A parent reply has been accepted for this blocker. */
        readonly answered: boolean;
      }[];
    };
    readonly cohorts?: readonly {
      readonly cohortId: string;
      /** The join has resolved; an unsettled cohort is still waiting on required children. */
      readonly settled: boolean;
      readonly failureReason?: string;
    }[];
    readonly children: readonly {
      readonly workItemKey: WorkItemKey;
      readonly workItemId: string;
      /** Provider reference of the child's primary resource (e.g. its PR), once it has one. */
      readonly externalRef?: string;
      readonly parentWorkItemKey: WorkItemKey;
      readonly objective: string;
      readonly workflowName: string;
      readonly status: string;
      readonly currentStage?: string;
      readonly cohortId: string;
      readonly repository?: { readonly resourceId: string; readonly pullRequestBase: string };
      readonly prerequisites?: readonly WorkItemKey[];
      /** Set only while a prerequisite is actually holding this child back. */
      readonly prerequisiteBlocker?: string;
      /** Original required assignment this corrective child replaces. */
      readonly replaces?: { readonly cohortId: string; readonly assignmentId: string };
      readonly outputs?: readonly {
        readonly name: string;
        readonly kind: string;
        readonly required: boolean;
        readonly selected: boolean;
        readonly stale: boolean;
        /** Declared per-output repository and PR base, when it differs from the child's. */
        readonly repository?: { readonly resourceId: string; readonly pullRequestBase: string };
      }[];
      readonly blockReason?: string;
      readonly resources: readonly ResourceItemResponse[];
    }[];
  };
  readonly triggerOrigin?: string;
  readonly work: WorkItemResponse;
  readonly resources: readonly ResourceItemResponse[];
  readonly orchestration: {
    readonly primary: WorkflowInstanceResponse | null;
    readonly children: readonly WorkflowInstanceResponse[];
    readonly diagram: { readonly href: string };
  };
  readonly execution: {
    readonly runs: readonly RunResponse[];
    readonly transcriptGroups: readonly TranscriptGroupResponse[];
  };
  readonly activities: { readonly pullRequest?: PullRequestResponse };
  readonly artifacts: readonly {
    readonly revisionId: string;
    readonly producer: string;
    readonly path: string;
    readonly occurredAt: string;
    readonly mediaType?: string;
    readonly byteLength?: number;
    readonly digest?: string;
    readonly href: string;
    /** Set when another work item published this artifact and it is in this item's context. */
    readonly source?: {
      readonly workItemKey: WorkItemKey;
      /** `granted` by a delegating parent, or `shared` through a trigger context. */
      readonly relation: 'granted' | 'shared';
    };
  }[];
  readonly conversation: {
    /** Whether this authenticated surface may create control-plane entries. */
    readonly canCreateEntries: boolean;
    /** Owning orchestration policy permits continuation with instructions. */
    readonly canContinue?: boolean;
    readonly entries: readonly {
      readonly entryId: string;
      readonly body: string;
      readonly occurredAt: string;
      readonly origin: string;
      readonly actorId: string;
      readonly runId?: string | undefined;
      readonly stage?: string | undefined;
      readonly sourceAdapter?: string | undefined;
      readonly sourceResourceId?: string | undefined;
      readonly sourceThreadId?: string | undefined;
      readonly deleted: boolean;
      readonly representations: readonly {
        readonly resourceId: string;
        readonly externalId: string;
      }[];
    }[];
  };
}

export interface ConversationMessageRequest {
  readonly idempotencyKey: string;
  readonly body: string;
  readonly continuation?: boolean;
}

export interface PullRequestResponse {
  readonly resourceId: string;
  readonly state: string;
  readonly frozen?: boolean;
  readonly deleted?: boolean;
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly checks: string;
}

export function toWorkItemKey(workItemId: string): WorkItemKey {
  return `wk_${btoa(workItemId).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

export function fromWorkItemKey(key: WorkItemKey): string {
  if (!/^wk_[A-Za-z0-9_-]+$/.test(key)) throw new Error('Invalid WorkItemKey');
  try {
    const encoded = key.slice(3).replaceAll('-', '+').replaceAll('_', '/');
    const value = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    if (value === '') throw new Error();
    return value;
  } catch {
    throw new Error('Invalid WorkItemKey');
  }
}
