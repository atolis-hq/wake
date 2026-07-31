import type { RunResponse } from './execution.js';
import type { WorkflowInstanceResponse } from './orchestration.js';
import type { ResourceItemResponse } from './resources.js';

/** A WorkItemKey is Wake's opaque, canonical work-item route identity. */
export type WorkItemKey = string;

export interface WorkItemResponse {
  readonly workItemKey: WorkItemKey;
  readonly workItemId: string;
  readonly objective: string;
  readonly state: string;
  readonly relatedWorkItems: readonly {
    readonly workItemKey: WorkItemKey;
    readonly relation: string;
  }[];
}

export interface WorkDetailResponse {
  readonly work: WorkItemResponse;
  readonly resources: readonly ResourceItemResponse[];
  readonly orchestration: {
    readonly primary: WorkflowInstanceResponse | null;
    readonly children: readonly WorkflowInstanceResponse[];
  };
  readonly execution: { readonly runs: readonly RunResponse[] };
  readonly activities: { readonly pullRequest?: PullRequestResponse };
}

export interface PullRequestResponse {
  readonly resourceId: string;
  readonly state: string;
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
