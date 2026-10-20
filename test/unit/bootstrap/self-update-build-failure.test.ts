import { expect, it } from 'vitest';
import { CandidateNotYetAvailableError } from '../../../src/bootstrap/self-update-application.js';
import { classifyCandidateBuildFailure } from '../../../src/bootstrap/self-update-build-failure.js';
import { DockerProcessError } from '../../../src/surfaces/index.js';

const etarget = [
  'npm error code ETARGET',
  'npm error notarget No matching version found for @atolis-hq/wake@0.4.107.',
].join('\n');

it('treats an unresolvable just-published version as retryable', () => {
  const failure = new DockerProcessError('docker build failed', { stdout: etarget, stderr: '' });

  const classified = classifyCandidateBuildFailure(failure, '@atolis-hq/wake', '0.4.107');

  expect(classified).toBeInstanceOf(CandidateNotYetAvailableError);
  expect((classified as Error).cause).toBe(failure);
});

it('reads the diagnostic from stderr as well as stdout', () => {
  const failure = new DockerProcessError('docker build failed', { stdout: '', stderr: etarget });

  expect(classifyCandidateBuildFailure(failure, '@atolis-hq/wake', '0.4.107')).toBeInstanceOf(
    CandidateNotYetAvailableError,
  );
});

it.each([
  ['a different version is unresolvable', etarget, '0.4.108'],
  [
    'a different package is unresolvable',
    etarget.replace('@atolis-hq/wake', 'left-pad'),
    '0.4.107',
  ],
  ['the build fails for another reason', 'npm error code E500\nregistry exploded', '0.4.107'],
])('keeps %s as a real build failure', (_name, output, tag) => {
  const failure = new DockerProcessError('docker build failed', { stdout: output, stderr: '' });

  expect(classifyCandidateBuildFailure(failure, '@atolis-hq/wake', tag)).toBe(failure);
});

it('passes through errors that are not Docker process failures', () => {
  const failure = new Error('boom');

  expect(classifyCandidateBuildFailure(failure, '@atolis-hq/wake', '0.4.107')).toBe(failure);
});
