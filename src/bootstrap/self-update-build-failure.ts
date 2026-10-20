import { DockerProcessError } from '../surfaces/index.js';
import { CandidateNotYetAvailableError } from './self-update-application.js';

/**
 * Turns a failed candidate image build into a retryable "not yet available"
 * error when npm could not resolve the just-published package version, which
 * happens briefly after a release while the registry propagates. Any other
 * build failure is returned unchanged and still marks the tag bad.
 */
export function classifyCandidateBuildFailure(
  error: unknown,
  packageName: string,
  tag: string,
): unknown {
  if (!(error instanceof DockerProcessError)) return error;
  const output = `${error.result.stdout}\n${error.result.stderr}`;
  const unresolvable =
    output.includes('ETARGET') &&
    output.includes(`No matching version found for ${packageName}@${tag}`);
  return unresolvable
    ? new CandidateNotYetAvailableError(
        `${packageName}@${tag} is not available from the npm registry yet; retry in a few minutes`,
        error,
      )
    : error;
}
