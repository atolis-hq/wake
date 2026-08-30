export interface EventProcessorArchitectureDiagnostic {
  readonly message: string;
}

export function checkEventProcessorArchitecture(
  root: string,
): Promise<readonly EventProcessorArchitectureDiagnostic[]>;
