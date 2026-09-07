import { defineClosedVocabulary, type ValueOf } from '../../../kernel/index.js';

export const ApiAdapterHealthStatus = defineClosedVocabulary({
  Unknown: 'unknown',
} as const);

export type ApiAdapterHealthStatus = 'ok' | 'degraded' | ValueOf<typeof ApiAdapterHealthStatus>;

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly version: string;
  readonly checkedAt: string;
  readonly checks?: readonly {
    readonly name: string;
    readonly status: 'ok' | 'degraded';
    readonly detail?: string;
  }[];
  readonly adapters?: readonly {
    readonly adapter: string;
    readonly provider: string;
    readonly scope: string;
    readonly channel: string;
    readonly status: ApiAdapterHealthStatus;
    readonly detail?: string;
    readonly successCount: number;
    readonly failureCount: number;
  }[];
}

export interface ConfigurationResponse {
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface CommandsResponse {
  readonly adapters: readonly {
    readonly adapter: string;
    readonly provider: string;
    readonly commands: readonly { readonly syntax: string }[];
  }[];
}

export interface WebhookSetupResponse {
  readonly adapters: readonly {
    readonly adapter: string;
    readonly provider: string;
    readonly hooks: readonly {
      readonly scope: string;
      readonly endpoint: string;
      readonly events: readonly string[];
      readonly secret: string;
    }[];
  }[];
}
