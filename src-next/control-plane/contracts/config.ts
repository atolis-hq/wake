export interface ScheduleConfig {
  readonly id: string;
  readonly workflow: string;
  readonly cron: string;
  readonly objective: string;
}

export interface ControlPlaneConfig {
  readonly maxDispatches: number;
  readonly schedules: readonly ScheduleConfig[];
}
