export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly version: string;
  readonly checkedAt: string;
  readonly checks?: readonly {
    readonly name: string;
    readonly status: 'ok' | 'degraded';
    readonly detail?: string;
  }[];
}

export interface ConfigurationResponse {
  readonly configuration: Readonly<Record<string, unknown>>;
}
