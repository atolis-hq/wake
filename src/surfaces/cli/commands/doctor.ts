export interface ProjectionMaintenance {
  health(): Promise<{
    readonly journal: string;
    readonly projections: readonly string[];
    readonly checkpoints: string;
  }>;
  rebuild(): Promise<void>;
}

export interface DoctorDependencies {
  readonly diagnose: () => Promise<{
    readonly failures: readonly string[];
    readonly notices: readonly string[];
  }>;
  readonly projections: ProjectionMaintenance;
}

export async function runDoctor(
  input: DoctorDependencies & { readonly rebuildProjections?: boolean },
) {
  if (input.rebuildProjections === true) await input.projections.rebuild();
  const [diagnostics, health] = await Promise.all([input.diagnose(), input.projections.health()]);
  return { ...diagnostics, ...health };
}
