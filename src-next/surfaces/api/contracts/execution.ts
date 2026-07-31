export interface RunResponse {
  readonly runId: string;
  readonly activationId: string;
  readonly activity: string;
  readonly workflowInstanceId: string;
  readonly orchestrationGroupId: string;
  readonly attempt: number;
  readonly status: string;
  readonly active: boolean;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome?: unknown;
  readonly failure?: { readonly kind: string };
}

export interface RunTranscriptResponse {
  readonly runId: string;
  readonly available: boolean;
  readonly entries: readonly {
    readonly occurredAt: string;
    readonly channel: string;
    readonly text: string;
  }[];
}

export interface RunnerResponse {
  readonly runnerId: string;
  readonly status: string;
  readonly available: boolean;
  readonly detail?: string;
  readonly updatedAt: string;
}
