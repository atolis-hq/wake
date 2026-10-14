import type { AnalyticsReportWindowId, WakeProblemDetails } from '../../../api/contracts/index.js';
import type {
  RunResolutionStatusValue,
  TriggerCommandNameValue,
} from '../../../api/contracts/transport-values.js';
import { object } from './decoder-primitives.js';
import {
  collectionDecoder,
  decodeAcceptedCommand,
  decodeAuditEvent,
  decodeBoardCard,
  decodeControlPlaneStatus,
  decodeResourceItem,
  decodeRun,
  decodeRunner,
  decodeTranscript,
  decodeWorkDetail,
  decodeWorkflow,
  decodeWorkflowDiagrams,
  decodeWorkItem,
  decodeWorkTranscript,
  resourceDecoder,
  type Decoder,
} from './decoders.js';
import { decodeReport, decodeReportCatalogue, decodeSummary } from './report-decoders.js';
import {
  decodeCommands,
  decodeConfiguration,
  decodeHealth,
  decodeMetrics,
  decodeProblem,
  decodeWebhookSetup,
} from './system-decoders.js';
import { decodeOrphanedInstructions, decodeTrigger, decodeTriggers } from './trigger-decoders.js';

export class ApiProblem extends Error {
  constructor(readonly problem: WakeProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiProblem';
  }
}

export class WakeApiClient {
  readonly auth = {
    session: async (): Promise<boolean> => {
      const fetchImplementation = this.fetchImplementation;
      const response = await fetchImplementation(`${this.baseUrl}/auth/session`);
      return response.ok;
    },
    login: async (accessKey: string): Promise<boolean> => {
      const fetchImplementation = this.fetchImplementation;
      const response = await fetchImplementation(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessKey }),
      });
      return response.ok;
    },
    redeem: async (grant: string): Promise<boolean> => {
      const fetchImplementation = this.fetchImplementation;
      const response = await fetchImplementation(`${this.baseUrl}/auth/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant }),
      });
      return response.ok;
    },
  };

  readonly triggers = {
    list: (signal?: AbortSignal) =>
      this.get(
        '/triggers',
        (value: unknown) => {
          const resource = resourceDecoder(decodeTriggers)(value);
          const record = object(value, 'triggers');
          return {
            ...resource,
            orphanedInstructions: decodeOrphanedInstructions(record.orphanedInstructions ?? []),
          };
        },
        signal,
      ),
    detail: (id: string, signal?: AbortSignal) =>
      this.get('/triggers/' + encodeURIComponent(id), resourceDecoder(decodeTrigger), signal),
    saveInstructions: (
      id: string,
      content: string,
      expectedRevisionId: string | null,
      idempotencyKey: string,
    ) =>
      this.request(
        '/triggers/' + encodeURIComponent(id) + '/commands/instructions',
        resourceDecoder(decodeAcceptedCommand),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, expectedRevisionId, idempotencyKey }),
        },
      ),
    command: (
      id: string,
      name: (typeof TriggerCommandNameValue)[keyof typeof TriggerCommandNameValue],
      idempotencyKey: string,
      signal?: AbortSignal,
    ) =>
      this.command(
        '/triggers/' + encodeURIComponent(id) + '/commands/' + name,
        idempotencyKey,
        decodeAcceptedCommand,
        signal,
      ),
  };

  readonly board = {
    list: (cursor?: string, signal?: AbortSignal) =>
      this.get(`/board${query({ cursor })}`, collectionDecoder(decodeBoardCard), signal),
  };

  readonly status = {
    get: (signal?: AbortSignal) =>
      this.get(
        '/status',
        resourceDecoder(
          (value) => value as { readonly conditionCounts: Readonly<Record<string, number>> },
        ),
        signal,
      ),
  };

  readonly controlPlane = {
    status: (signal?: AbortSignal) =>
      this.get('/control-plane/status', resourceDecoder(decodeControlPlaneStatus), signal),
    pauseDispatch: (idempotencyKey: string, signal?: AbortSignal) =>
      this.command(
        '/control-plane/commands/pause-dispatch',
        idempotencyKey,
        decodeAcceptedCommand,
        signal,
      ),
    resumeDispatch: (idempotencyKey: string, signal?: AbortSignal) =>
      this.command(
        '/control-plane/commands/resume-dispatch',
        idempotencyKey,
        decodeAcceptedCommand,
        signal,
      ),
    clearMaintenance: (attemptId: string, idempotencyKey: string, signal?: AbortSignal) =>
      this.request(
        '/control-plane/commands/clear-maintenance',
        resourceDecoder(decodeAcceptedCommand),
        {
          method: 'POST',
          body: JSON.stringify({ attemptId, idempotencyKey }),
          headers: { 'content-type': 'application/json' },
          ...(signal === undefined ? {} : { signal }),
        },
      ),
  };

  readonly work = {
    list: (
      parameters: {
        readonly cursor?: string;
        readonly search?: string;
        readonly state?: string;
      } = {},
      signal?: AbortSignal,
    ) => this.get(`/work-items${query(parameters)}`, collectionDecoder(decodeWorkItem), signal),
    detail: (key: string, signal?: AbortSignal) =>
      this.get(`/work-items/${encodeURIComponent(key)}`, resourceDecoder(decodeWorkDetail), signal),
    artifactText: async (key: string, revisionId: string, signal?: AbortSignal) => {
      const fetchImplementation = this.fetchImplementation;
      const response = await fetchImplementation(
        `${this.baseUrl}/work-items/${encodeURIComponent(key)}/artifacts/${encodeURIComponent(revisionId)}`,
        { ...(signal === undefined ? {} : { signal }) },
      );
      if (!response.ok) throw new Error('Unable to load this artifact. Please try again.');
      return response.text();
    },
    transcript: (key: string, groupId: string, signal?: AbortSignal) =>
      this.get(
        `/work-items/${encodeURIComponent(key)}/transcripts/${encodeURIComponent(groupId)}`,
        resourceDecoder(decodeWorkTranscript),
        signal,
      ),
    message: (
      key: string,
      body: string,
      idempotencyKey: string,
      signal?: AbortSignal,
      continuation?: boolean,
    ) =>
      this.request(
        `/work-items/${encodeURIComponent(key)}/commands/message`,
        resourceDecoder(decodeAcceptedCommand),
        {
          method: 'POST',
          body: JSON.stringify({
            idempotencyKey,
            body,
            ...(continuation === undefined ? {} : { continuation }),
          }),
          headers: { 'content-type': 'application/json' },
          ...(signal === undefined ? {} : { signal }),
        },
      ),
    command: (
      key: string,
      name: 'freeze' | 'unfreeze' | 'delete' | 'retry' | 'extend',
      idempotencyKey: string,
      signal?: AbortSignal,
    ) =>
      this.command(
        `/work-items/${encodeURIComponent(key)}/commands/${name}`,
        idempotencyKey,
        decodeAcceptedCommand,
        signal,
      ),
  };

  readonly resources = {
    list: (cursor?: string, signal?: AbortSignal) =>
      this.get(`/resources${query({ cursor })}`, collectionDecoder(decodeResourceItem), signal),
  };

  readonly orchestration = {
    list: (cursor?: string, signal?: AbortSignal) =>
      this.get(
        `/workflow-instances${query({ cursor })}`,
        collectionDecoder(decodeWorkflow),
        signal,
      ),
  };

  readonly workflowDiagrams = {
    get: (workItemKey?: string, signal?: AbortSignal) =>
      this.get(
        `/workflow-diagrams${query({ workItemKey })}`,
        resourceDecoder(decodeWorkflowDiagrams),
        signal,
      ),
  };

  readonly execution = {
    runs: (cursor?: string, signal?: AbortSignal) =>
      this.get(`/runs${query({ cursor })}`, collectionDecoder(decodeRun), signal),
    run: (runId: string, signal?: AbortSignal) =>
      this.get(`/runs/${encodeURIComponent(runId)}`, resourceDecoder(decodeRun), signal),
    transcript: (runId: string, signal?: AbortSignal) =>
      this.get(
        `/runs/${encodeURIComponent(runId)}/transcript`,
        resourceDecoder(decodeTranscript),
        signal,
      ),
    resolveAmbiguousRun: (
      runId: string,
      resolution:
        | { readonly status: typeof RunResolutionStatusValue.Failed; readonly reason: string }
        | {
            readonly status: typeof RunResolutionStatusValue.Succeeded;
            readonly outcome: unknown;
          },
      idempotencyKey: string,
      signal?: AbortSignal,
    ) =>
      this.request(
        `/runs/${encodeURIComponent(runId)}/commands/resolve`,
        resourceDecoder(decodeAcceptedCommand),
        {
          method: 'POST',
          body: JSON.stringify({ idempotencyKey, ...resolution }),
          headers: { 'content-type': 'application/json' },
          ...(signal === undefined ? {} : { signal }),
        },
      ),
    runners: (signal?: AbortSignal) =>
      this.get('/runners', collectionDecoder(decodeRunner), signal),
    pauseRunner: (runnerId: string, idempotencyKey: string, signal?: AbortSignal) =>
      this.command(
        `/runners/${encodeURIComponent(runnerId)}/commands/pause`,
        idempotencyKey,
        decodeAcceptedCommand,
        signal,
      ),
    unpauseRunner: (runnerId: string, idempotencyKey: string, signal?: AbortSignal) =>
      this.command(
        `/runners/${encodeURIComponent(runnerId)}/commands/unpause`,
        idempotencyKey,
        decodeAcceptedCommand,
        signal,
      ),
  };

  readonly events = {
    list: (cursor?: string, workItemKeyOrSignal?: string | AbortSignal, signal?: AbortSignal) => {
      const workItemKey = typeof workItemKeyOrSignal === 'string' ? workItemKeyOrSignal : undefined;
      const requestSignal = typeof workItemKeyOrSignal === 'string' ? signal : workItemKeyOrSignal;
      return this.get(
        `/events${query({ cursor, workItemKey })}`,
        collectionDecoder(decodeAuditEvent),
        requestSignal,
      );
    },
  };

  readonly observability = {
    reports: (signal?: AbortSignal) =>
      this.get('/observability/reports', resourceDecoder(decodeReportCatalogue), signal),
    report: (window: AnalyticsReportWindowId, report: string, signal?: AbortSignal) =>
      this.get(
        '/observability/reports' + query({ window, report }),
        resourceDecoder(decodeReport),
        signal,
      ),
    summary: (window: AnalyticsReportWindowId, signal?: AbortSignal) =>
      this.get(
        '/observability/summary' + query({ window }),
        resourceDecoder(decodeSummary),
        signal,
      ),
    metrics: (days = 7, signal?: AbortSignal) =>
      this.get(
        `/observability/metrics${query({ days: String(days) })}`,
        resourceDecoder(decodeMetrics),
        signal,
      ),
  };

  readonly system = {
    health: (signal?: AbortSignal) =>
      this.get('/system/health', resourceDecoder(decodeHealth), signal),
    configuration: (signal?: AbortSignal) =>
      this.get('/system/configuration', resourceDecoder(decodeConfiguration), signal),
    commands: (signal?: AbortSignal) =>
      this.get('/system/commands', resourceDecoder(decodeCommands), signal),
    webhooks: (signal?: AbortSignal) =>
      this.get('/system/webhooks', resourceDecoder(decodeWebhookSetup), signal),
  };

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly baseUrl = '/api/v1',
  ) {}

  private async command<Result>(
    path: string,
    idempotencyKey: string,
    decoder: Decoder<Result>,
    signal?: AbortSignal,
  ) {
    return this.request(path, resourceDecoder(decoder), {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey }),
      headers: { 'content-type': 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private get<T>(path: string, decoder: Decoder<T>, signal?: AbortSignal): Promise<T> {
    return this.request(path, decoder, signal === undefined ? {} : { signal });
  }

  private async request<T>(path: string, decoder: Decoder<T>, init: RequestInit): Promise<T> {
    const fetchImplementation = this.fetchImplementation;
    const response = await fetchImplementation(`${this.baseUrl}${path}`, {
      ...init,
      headers: { accept: 'application/json, application/problem+json', ...init.headers },
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new ApiProblem(decodeProblem(body, response.status));
    return decoder(body);
  }
}

function query(values: Readonly<Record<string, string | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') search.set(key, value);
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}
