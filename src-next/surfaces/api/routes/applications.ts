import type {
  ApiCommandResult,
  ApiTickCommandResult,
  AuditEventResponse,
  BoardCardResponse,
  BoardResponse,
  ConfigurationResponse,
  ControlPlaneStatusResponse,
  HealthResponse,
  MetricsResponse,
  ResourceItemResponse,
  ResourceResponse,
  ResponseMeta,
  RunnerResponse,
  RunResponse,
  RunTranscriptResponse,
  StatusResponse,
  WorkDetailResponse,
  WorkflowInstanceResponse,
  WorkItemResponse,
} from '../contracts/index.js';

export interface CollectionQuery {
  readonly cursor?: { readonly position: number };
  readonly limit: number;
  readonly search?: string;
  readonly state?: string;
  readonly workItemKey?: string;
}

export interface ApiCollectionPage<T> {
  readonly items: readonly T[];
  readonly meta: ResponseMeta;
  readonly total?: number;
  readonly nextPosition?: number;
  readonly continuationPosition?: number;
}

export type ApiResourceResult<T> = ResourceResponse<T>;

export interface ApiCommandRequest {
  readonly idempotencyKey: string;
}

export interface ApiSystemApplications {
  health(): Promise<ApiResourceResult<HealthResponse>>;
  configuration(): Promise<ApiResourceResult<ConfigurationResponse>>;
}

export interface ApiApplications {
  readonly now: () => string;
  readonly board?: {
    list(query: CollectionQuery): Promise<
      ApiCollectionPage<BoardCardResponse> & {
        readonly conditionCounts: BoardResponse['conditionCounts'];
      }
    >;
  };
  readonly status?: { get(): Promise<ApiResourceResult<StatusResponse>> };
  readonly controlPlane: {
    status(): Promise<ApiResourceResult<ControlPlaneStatusResponse>>;
    pause?(command: ApiCommandRequest): Promise<ApiCommandResult>;
    resume?(command: ApiCommandRequest): Promise<ApiCommandResult>;
    tick?(command: ApiCommandRequest): Promise<ApiTickCommandResult>;
  };
  readonly work: {
    list(query: CollectionQuery): Promise<ApiCollectionPage<WorkItemResponse>>;
    detail(key: string): Promise<ApiResourceResult<WorkDetailResponse> | undefined>;
    freeze?(key: string, command: ApiCommandRequest): Promise<ApiCommandResult>;
    unfreeze?(key: string, command: ApiCommandRequest): Promise<ApiCommandResult>;
    delete?(key: string, command: ApiCommandRequest): Promise<ApiCommandResult>;
    retry?(key: string, command: ApiCommandRequest): Promise<ApiCommandResult>;
  };
  readonly resources: {
    list(query: CollectionQuery): Promise<ApiCollectionPage<ResourceItemResponse>>;
  };
  readonly orchestration: {
    list(query: CollectionQuery): Promise<ApiCollectionPage<WorkflowInstanceResponse>>;
  };
  readonly execution: {
    list(query: CollectionQuery): Promise<ApiCollectionPage<RunResponse>>;
    get?(runId: string): Promise<ApiResourceResult<RunResponse> | undefined>;
    transcript?(runId: string): Promise<ApiResourceResult<RunTranscriptResponse> | undefined>;
    runners?(query: CollectionQuery): Promise<ApiCollectionPage<RunnerResponse>>;
    pauseRunner?(runnerId: string, command: ApiCommandRequest): Promise<ApiCommandResult>;
    unpauseRunner?(runnerId: string, command: ApiCommandRequest): Promise<ApiCommandResult>;
  };
  readonly events: {
    list(query: CollectionQuery): Promise<ApiCollectionPage<AuditEventResponse>>;
  };
  readonly observability: {
    metrics(query?: { readonly days: number }): Promise<ApiResourceResult<MetricsResponse>>;
  };
  readonly system: ApiSystemApplications;
}
