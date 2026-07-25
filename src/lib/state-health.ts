export type StateHealthIssueKind = 'corrupted' | 'incomplete' | 'unreadable';

export type StateHealthIssue = {
  path: string;
  surface: 'events' | 'state' | 'reverse-index';
  kind: StateHealthIssueKind;
  message: string;
};

export type StateHealthReport = {
  healthy: boolean;
  issues: StateHealthIssue[];
};

export class StateHealthError extends Error {
  readonly issues: StateHealthIssue[];

  constructor(issues: StateHealthIssue[]) {
    super(formatStateHealthErrorMessage(issues));
    this.name = 'StateHealthError';
    this.issues = issues;
  }
}

export function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function isMissingPathError(error: unknown): boolean {
  return isNodeErrnoException(error) && error.code === 'ENOENT';
}

export function stateHealthIssue(input: StateHealthIssue): StateHealthIssue {
  return input;
}

export function throwIfUnhealthy(issues: StateHealthIssue[]): void {
  if (issues.length > 0) {
    throw new StateHealthError(issues);
  }
}

export function formatStateHealthErrorMessage(issues: StateHealthIssue[]): string {
  if (issues.length === 0) {
    return 'Wake control-plane state is healthy';
  }

  const first = issues[0]!;
  const suffix = issues.length === 1 ? '' : ` and ${issues.length - 1} more issue(s)`;
  return `Wake control-plane state is unhealthy: ${first.surface} ${first.kind} at ${first.path}: ${first.message}${suffix}`;
}
