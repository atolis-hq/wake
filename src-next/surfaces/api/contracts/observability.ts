export interface AnalyticsWindowResponse {
  readonly days: number;
  readonly from: string;
  readonly to: string;
}

export interface MetricsResponse {
  readonly collectedAt: string;
  readonly window: AnalyticsWindowResponse;
  readonly values: Readonly<Record<string, number>>;
}
