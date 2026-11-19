import { expect, it } from 'vitest';
import { CandidateNotYetAvailableError } from '../../../src/bootstrap/self-update-application.js';
import {
  buildCandidateWithRetry,
  classifyCandidateBuildFailure,
} from '../../../src/bootstrap/self-update-build-failure.js';
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

const notFound =
  'npm error 404 Not Found - GET https://registry.npmjs.org/@atolis-hq/wake/-/wake-0.4.107.tgz - Not found';

it.each([notFound, notFound.replace('@atolis-hq/wake', '@atolis-hq%2fwake')])(
  'classifies candidate tarball 404: %s',
  (output) => {
    expect(
      classifyCandidateBuildFailure(
        new DockerProcessError('failed', { stdout: output, stderr: '' }),
        '@atolis-hq/wake',
        '0.4.107',
      ),
    ).toBeInstanceOf(CandidateNotYetAvailableError);
  },
);

it.each([
  notFound.replace('0.4.107', '0.4.108'),
  notFound.replaceAll('@atolis-hq/wake', 'other').replace('wake-0.4.107', 'other-0.4.107'),
  'npm error 404 Not Found - GET https://registry.npmjs.org/dependency',
  'npm error code E500',
])('does not retry unrelated diagnostics: %s', (output) => {
  const failure = new DockerProcessError('failed', { stdout: '', stderr: output });
  expect(classifyCandidateBuildFailure(failure, '@atolis-hq/wake', '0.4.107')).toBe(failure);
});

it('bounds retries with backoff and preserves retryable exhaustion', async () => {
  const delays: number[] = [];
  let attempts = 0;
  await expect(
    buildCandidateWithRetry(
      async () => {
        attempts++;
        throw new DockerProcessError('failed', { stdout: notFound, stderr: '' });
      },
      '@atolis-hq/wake',
      '0.4.107',
      async (delay) => {
        delays.push(delay);
      },
    ),
  ).rejects.toBeInstanceOf(CandidateNotYetAvailableError);
  expect(attempts).toBe(4);
  expect(delays).toEqual([1000, 2000, 4000]);
});

it('returns after a successful retry and stops immediately for real failures', async () => {
  let attempts = 0;
  await buildCandidateWithRetry(
    async () => {
      if (++attempts === 1)
        throw new DockerProcessError('failed', { stdout: notFound, stderr: '' });
    },
    '@atolis-hq/wake',
    '0.4.107',
    async () => {},
  );
  expect(attempts).toBe(2);
  const failure = new Error('broken build');
  await expect(
    buildCandidateWithRetry(
      async () => {
        throw failure;
      },
      '@atolis-hq/wake',
      '0.4.107',
      async () => {
        throw new Error('unexpected sleep');
      },
    ),
  ).rejects.toBe(failure);
});
