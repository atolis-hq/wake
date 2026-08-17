import { afterEach, expect, it, vi } from 'vitest';
import {
  createBoundedGitHubFetch,
  GitHubRequestTimeoutError,
} from '../../../src/integrations/github/infrastructure/bounded-fetch.js';

afterEach(() => {
  vi.useRealTimers();
});

function abortableFetch(): typeof globalThis.fetch {
  return (_input, init) =>
    new Promise((resolve, reject) => {
      const settle = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (init?.signal?.aborted) return settle();
      init?.signal?.addEventListener('abort', settle, { once: true });
      // Never resolves on its own — only settles via abort, simulating a GitHub
      // connection that hangs instead of returning a clean error response.
    });
}

it('resolves normally when the underlying fetch completes before the timeout', async () => {
  const baseFetch: typeof globalThis.fetch = async () => new Response('{"ok":true}');
  const fetch = createBoundedGitHubFetch(baseFetch, 8 * 1024 * 1024, 1_000);
  const response = await fetch('https://api.github.com/repos/o/r');
  await expect(response.json()).resolves.toEqual({ ok: true });
});

it('aborts and rejects with GitHubRequestTimeoutError when the underlying fetch never settles', async () => {
  vi.useFakeTimers();
  const fetch = createBoundedGitHubFetch(abortableFetch(), 8 * 1024 * 1024, 5_000);
  const result = fetch('https://api.github.com/repos/o/r');
  const assertion = expect(result).rejects.toThrow(GitHubRequestTimeoutError);
  await vi.advanceTimersByTimeAsync(5_000);
  await assertion;
});

it('passes an abort signal through to the underlying fetch so it can stop work once timed out', async () => {
  vi.useFakeTimers();
  let observedSignal: AbortSignal | undefined;
  const fetch = createBoundedGitHubFetch(
    (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
      });
    },
    8 * 1024 * 1024,
    5_000,
  );
  const result = fetch('https://api.github.com/repos/o/r');
  const assertion = expect(result).rejects.toThrow(GitHubRequestTimeoutError);
  await vi.advanceTimersByTimeAsync(5_000);
  await assertion;
  expect(observedSignal?.aborted).toBe(true);
});

it('still rejects with the caller-supplied signal reason when the caller aborts before the timeout', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetch = createBoundedGitHubFetch(abortableFetch(), 8 * 1024 * 1024, 5_000);
  const result = fetch('https://api.github.com/repos/o/r', { signal: controller.signal });
  const assertion = result.catch((error: unknown) => {
    expect(error).not.toBeInstanceOf(GitHubRequestTimeoutError);
    throw error;
  });
  controller.abort();
  await expect(assertion).rejects.toThrow('The operation was aborted.');
});
