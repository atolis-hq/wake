import { createHash } from 'node:crypto';
import { isGitHubWakeMarker } from '../contracts/vocabulary.js';

// Wake's own status/stage/workflow labels are excluded so republishing them never
// looks like an external change — see reconcileGitHubWakeLabels.
export function gitHubContentFingerprint(input: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function withoutWakeMarkers(labels: readonly string[]): readonly string[] {
  return [...labels].filter((label) => !isGitHubWakeMarker(label)).sort();
}
