import { isGitHubWakeMarker } from '../contracts/vocabulary.js';

export function reconcileGitHubWakeLabels(
  current: readonly string[],
  desired: readonly string[],
): readonly string[] {
  const userLabels = current.filter((label) => !isGitHubWakeMarker(label));
  return [...userLabels, ...desired];
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
    input.labels.some(isGitHubWakeMarker)
  );
}
