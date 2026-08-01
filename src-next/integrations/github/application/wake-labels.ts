const wakeLabelPrefixes = ['wake:status.', 'wake:stage.', 'wake:workflow.'] as const;

export function reconcileGitHubWakeLabels(
  current: readonly string[],
  desired: readonly string[],
): readonly string[] {
  const userLabels = current.filter((label) => !isGitHubWakeLabel(label));
  return [...userLabels, ...desired];
}

function isGitHubWakeLabel(label: string): boolean {
  return wakeLabelPrefixes.some((prefix) => label.startsWith(prefix));
}

export function isGitHubWakeEcho(input: {
  readonly authorLogin: string;
  readonly authenticatedLogin: string;
  readonly body: string;
  readonly labels: readonly string[];
}): boolean {
  return (
    input.authorLogin.toLowerCase() === input.authenticatedLogin.toLowerCase() ||
    input.body.includes('<!-- wake:agent -->') ||
    input.labels.some(isGitHubWakeLabel)
  );
}
