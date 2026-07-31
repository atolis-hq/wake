export interface MetricsResponse {
  readonly collectedAt: string;
  readonly values: Readonly<Record<string, number>>;
}
