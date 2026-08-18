interface RunState {
  readonly active: boolean;
}

export const refreshPolicy = {
  status: 2_000,
  board: 3_000,
  openWork: 3_000,
  activeRuns: 3_000,
  events: 3_000,
  historicalRuns: 5_000,
  health: 5_000,
  runners: 5_000,
  observability: false,
  configuration: false,
  commands: false,
} as const;

export const refreshInterval = {
  runs: (runs: readonly RunState[] | undefined) =>
    runs?.some((run) => run.active) === true
      ? refreshPolicy.activeRuns
      : refreshPolicy.historicalRuns,
};
