export interface EventArchitectureDiagnostic {
  readonly message: string;
}

export function checkEventArchitecture(
  root?: string,
): Promise<readonly EventArchitectureDiagnostic[]>;
