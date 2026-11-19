import { setTimeout } from 'node:timers/promises';
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
  const tarball = packageName + '/-/' + packageName.split('/').at(-1) + '-' + tag + '.tgz';
  const notFound = output.split('\n').some(
    (line) =>
      line.includes('npm error') &&
      /\b404\b/.test(line) &&
      line.toLowerCase().includes('not found') &&
      line
        .replace(/%2f/gi, '/')
        .split(/[\s'"]/)
        .some((token) => token.endsWith('/' + tarball)),
  );
  return unresolvable || notFound
    ? new CandidateNotYetAvailableError(
        `${packageName}@${tag} is not available from the npm registry yet; retry in a few minutes`,
        error,
      )
    : error;
}

/** Retry only registry availability failures. */
export async function buildCandidateWithRetry(
  build: () => Promise<void>,
  packageName: string,
  tag: string,
  sleep: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<void> {
  const delays = [1_000, 2_000, 4_000];
  for (let attempt = 0; ; attempt++) {
    try {
      await build();
      return;
    } catch (error) {
      const classified = classifyCandidateBuildFailure(error, packageName, tag);
      const delay = delays[attempt];
      if (!(classified instanceof CandidateNotYetAvailableError) || delay === undefined)
        throw classified;
      await sleep(delay);
    }
  }
}
