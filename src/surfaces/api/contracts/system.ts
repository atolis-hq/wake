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
    readonly status: 'ok' | 'degraded';
    readonly detail?: string;
    readonly successCount: number;
    readonly failureCount: number;
  }[];
}

export interface ConfigurationResponse {
  readonly configuration: Readonly<Record<string, unknown>>;
}
