export interface ProjectionMaintenance {
  health(): Promise<{
    readonly journal: string;
    readonly projections: string;
    readonly checkpoints: string;
  }>;
  rebuildProjections(): Promise<void>;
}

export async function validateState(
  application: ProjectionMaintenance,
  rebuildProjections = false,
) {
  if (rebuildProjections) await application.rebuildProjections();
  return application.health();
}
