export const executionRoutes = [
  '/api/v1/runs',
  '/api/v1/runs/:runId',
  '/api/v1/runs/:runId/transcript',
  '/api/v1/runs/:runId/commands/resolve-failed',
  '/api/v1/runners',
  '/api/v1/runners/:runnerId/commands/pause',
  '/api/v1/runners/:runnerId/commands/unpause',
] as const;
