import type { WakeProblemDetails } from '../../../api/contracts/index.js';
import type { RunResolutionStatusValue } from '../../../api/contracts/transport-values.js';
import {
  collectionDecoder,
  decodeAcceptedCommand,
  decodeAuditEvent,
  decodeBoardCard,
  decodeControlPlaneStatus,
  decodeResourceItem,
  decodeRun,
  decodeRunner,
  decodeTickCommand,
  decodeTranscript,
  decodeWorkDetail,
  decodeWorkflow,
  decodeWorkflowDiagrams,
  decodeWorkItem,
  decodeWorkTranscript,
  resourceDecoder,
  type Decoder,
} from './decoders.js';
import {
  decodeCommands,
  decodeConfiguration,
  decodeHealth,
  decodeMetrics,
  decodeProblem,
} from './system-decoders.js';

export class ApiProblem extends Error {
  constructor(readonly problem: WakeProblemDetails) {
    super(problem.title);
    this.name = 'ApiProblem';
  }
}

export class WakeApiClient {
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
    pause: (idempotencyKey: string, signal?: AbortSignal) =>
      this.command('/control-plane/commands/pause', idempotencyKey, decodeAcceptedCommand, signal),
    resume: (idempotencyKey: string, signal?: AbortSignal) =>
      this.command('/control-plane/commands/resume', idempotencyKey, decodeAcceptedCommand, signal),
    tick: (idempotencyKey: string, signal?: AbortSignal) =>
      this.command('/control-plane/commands/tick', idempotencyKey, decodeTickCommand, signal),
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
    transcript: (key: string, groupId: string, signal?: AbortSignal) =>
      this.get(
        `/work-items/${encodeURIComponent(key)}/transcripts/${encodeURIComponent(groupId)}`,
        resourceDecoder(decodeWorkTranscript),
        signal,
      ),
    command: (
      key: string,
      name: 'freeze' | 'unfreeze' | 'delete' | 'retry',
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
