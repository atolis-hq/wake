export interface EventArchitectureDiagnostic {
  readonly message: string;
}

export interface EventArchitectureAnalysisStats {
  readonly originEdges: number;
  readonly uniqueOriginStates: number;
}

export interface EventArchitectureAnalysis {
  readonly diagnostics: readonly EventArchitectureDiagnostic[];
  readonly stats: EventArchitectureAnalysisStats;
}

export function checkEventArchitecture(
  root?: string,
): Promise<readonly EventArchitectureDiagnostic[]>;

export function checkEventArchitectureWithStats(root?: string): Promise<EventArchitectureAnalysis>;
