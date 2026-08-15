import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireFileLock } from '../../../src/persistence/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});

it('permits one file-lock owner at a time', async () => {
  const path = await lockPath('journal.lock');
  const first = await acquireFileLock(path);
  try {
    const second = await acquireFileLock(path);
    expect([first.acquired, second.acquired]).toEqual([true, false]);
  } finally {
    await first.release();
  }
});

it('removes an empty strict owner directory after the last release', async () => {
  const path = await lockPath('strict-cleanup.lock');
  const owner = await acquireFileLock(path, { staleRequiresDeadProcess: true });

  await owner.release();

  await expect(access(`${path}.owners`)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not reclaim a stale attempt lock while its recorded local owner is alive', async () => {
  const path = await lockPath('attempt.lock');
  const first = await acquireFileLock(path, {
    now: new Date(0),
    staleRequiresDeadProcess: true,
  });
  const second = await acquireFileLock(path, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => true,
  });

  try {
    expect([first.acquired, second.acquired]).toEqual([true, false]);
  } finally {
    await first.release();
  }
});

it('reclaims a stale attempt lock only when its injected owner probe reports dead', async () => {
  const path = await lockPath('attempt.lock');
  const first = await acquireFileLock(path, {
    now: new Date(0),
    staleRequiresDeadProcess: true,
  });
  const second = await acquireFileLock(path, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => false,
  });

  try {
    expect([first.acquired, second.acquired]).toEqual([true, true]);
  } finally {
    await first.release();
    await expect(access(path)).resolves.toBeUndefined();
    await second.release();
    await expect(access(path)).rejects.toThrow();
  }
});

it('removes the compatibility sentinel after recovering a crashed strict owner', async () => {
  const path = await lockPath('crashed-strict-owner.lock');
  const crashed = await acquireFileLock(path, {
    now: new Date(0),
    staleRequiresDeadProcess: true,
  });
  const recovered = await acquireFileLock(path, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => false,
  });

  expect(recovered.acquired).toBe(true);
  await recovered.release();
  await expect(access(path)).rejects.toThrow();
  await expect(access(`${path}.owners`)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(crashed.release()).resolves.toBeUndefined();
});

it('retains time-only stale recovery when dead-process proof is not requested', async () => {
  const path = await lockPath('time-only.lock');
  const first = await acquireFileLock(path, { now: new Date(0) });
  const second = await acquireFileLock(path, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
  });

  expect([first.acquired, second.acquired]).toEqual([true, true]);
  await first.release();
  await expect(access(path)).resolves.toBeUndefined();
  await second.release();
  await expect(access(path)).rejects.toThrow();
});

it('allows exactly one concurrent contender to recover a dead stale lock', async () => {
  for (let round = 0; round < 25; round += 1) {
    const path = await lockPath(`concurrent-stale-${round}.lock`);
    const stale = await acquireFileLock(path, {
      now: new Date(0),
      staleRequiresDeadProcess: true,
    });
    const contenders = await Promise.all(
      Array.from({ length: 16 }, () =>
        acquireFileLock(path, {
          now: new Date(61_000),
          staleAfterMs: 60_000,
          staleRequiresDeadProcess: true,
          isProcessAlive: () => false,
        }),
      ),
    );
    const winners = contenders.filter(({ acquired }) => acquired);

    expect(winners.length, `round ${round}: ${JSON.stringify(winners)}`).toBeLessThanOrEqual(1);

    if (winners.length === 0) {
      const retry = await acquireFileLock(path, {
        now: new Date(61_000),
        staleAfterMs: 60_000,
        staleRequiresDeadProcess: true,
        isProcessAlive: () => false,
      });
      expect(retry.acquired).toBe(true);
      await retry.release();
    } else {
      await expect(acquireFileLock(path)).resolves.toMatchObject({ acquired: false });
    }

    await stale.release();
    if (winners.length === 1)
      await expect(acquireFileLock(path)).resolves.toMatchObject({ acquired: false });
    await Promise.all(contenders.map(({ release }) => release()));
  }
});

it('releases its own record even when another acquisition contends', async () => {
  const path = await lockPath('release-contention.lock');
  const strict = { staleRequiresDeadProcess: true } as const;
  const owner = await acquireFileLock(path, strict);
  const [contender] = await Promise.all([acquireFileLock(path, strict), owner.release()]);
  await contender.release();
  const next = await acquireFileLock(path, strict);

  expect(next.acquired).toBe(true);
  await next.release();
});

it('does not expose last-owner directory cleanup as an acquisition failure', async () => {
  const strict = { staleRequiresDeadProcess: true } as const;
  for (let round = 0; round < 100; round += 1) {
    const path = await lockPath(`last-owner-cleanup-${round}.lock`);
    const owner = await acquireFileLock(path, strict);

    const [contender] = await Promise.all([acquireFileLock(path, strict), owner.release()]);

    expect(contender.acquired).toBeTypeOf('boolean');
    await contender.release();
  }
});

it(
  'never allows multiple stale-recovery winners across concurrent OS processes',
  { timeout: 60_000 },
  async () => {
    const path = await lockPath('process-stale.lock');
    const root = join(path, '..');
    const stale = await acquireFileLock(path, {
      now: new Date(0),
      staleRequiresDeadProcess: true,
    });
    const go = join(root, 'go');
    const release = join(root, 'release');
    const winners = join(root, 'winners');
    const children = Array.from({ length: 4 }, (_, index) => {
      const ready = join(root, `ready-${index}`);
      const done = join(root, `done-${index}`);
      const child = spawn(
        process.execPath,
        [
          join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
          'test/integration/persistence/file-lock-contender.ts',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            WAKE_LOCK_PATH: path,
            WAKE_LOCK_READY: ready,
            WAKE_LOCK_GO: go,
            WAKE_LOCK_DONE: done,
            WAKE_LOCK_WINNERS: winners,
            WAKE_LOCK_RELEASE: release,
          },
          stdio: 'inherit',
        },
      );
      return { child, ready, done };
    });
    await Promise.all(children.map(({ child, ready }) => waitForChildPath(ready, child)));
    await writeFile(go, 'go\n');
    await Promise.all(children.map(({ child, done }) => waitForChildPath(done, child)));

    const winnerPids = await readFile(winners, 'utf8')
      .then((value) => value.trim().split('\n').filter(Boolean))
      .catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? [] : Promise.reject(error),
      );
    expect(winnerPids.length).toBeLessThanOrEqual(1);
    await stale.release();
    if (winnerPids.length === 1)
      await expect(acquireFileLock(path)).resolves.toMatchObject({ acquired: false });

    await writeFile(release, 'release\n');
    await Promise.all(children.map(({ child }) => waitForChildExit(child)));
  },
);

it('fails closed when an attempt-owner liveness probe is indeterminate', async () => {
  const path = await lockPath('attempt.lock');
  const first = await acquireFileLock(path, {
    now: new Date(0),
    staleRequiresDeadProcess: true,
  });
  const second = await acquireFileLock(path, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => {
      const error = new Error('access denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    },
  });

  try {
    expect([first.acquired, second.acquired]).toEqual([true, false]);
  } finally {
    await first.release();
  }
});

it('uses an incomplete record filename only after proving its stale owner dead', async () => {
  const path = await lockPath('incomplete-owner.lock');
  const owners = `${path}.owners`;
  await mkdir(owners, { recursive: true });
  await writeFile(join(owners, '123-0-incomplete.json'), '');

  await expect(
    acquireFileLock(path, {
      now: new Date(61_000),
      staleAfterMs: 60_000,
      staleRequiresDeadProcess: true,
      isProcessAlive: () => true,
    }),
  ).resolves.toMatchObject({ acquired: false });
  const recovered = await acquireFileLock(path, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => false,
  });

  expect(recovered.acquired).toBe(true);
  await recovered.release();
});

it('publishes a legacy-path sentinel while a new owner is active', async () => {
  const path = await lockPath('compatibility-owner.lock');
  const owner = await acquireFileLock(path, { staleRequiresDeadProcess: true });

  await expect(open(path, 'wx')).rejects.toMatchObject({ code: 'EEXIST' });
  await owner.release();
  const legacy = await open(path, 'wx');
  await legacy.close();
});

it('strict acquisition fails closed on a non-compatibility legacy lock', async () => {
  const path = await lockPath('legacy-migration.lock');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ pid: 123, acquiredAt: new Date(0).toISOString(), lockId: 'legacy' })}\n`,
  );
  const options = {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => false,
  } as const;

  await expect(acquireFileLock(path, options)).resolves.toMatchObject({ acquired: false });
  await rm(path);
  await expect(acquireFileLock(path, options)).resolves.toMatchObject({ acquired: true });
});

it('compacts proven-dead records and fails closed above the scan bound', async () => {
  const compactPath = await lockPath('compact.lock');
  const compactOwners = `${compactPath}.owners`;
  await mkdir(compactOwners, { recursive: true });
  for (let index = 0; index < 3; index += 1)
    await writeFile(join(compactOwners, `${index + 1}-0-dead-${index}.json`), '');
  const compacted = await acquireFileLock(compactPath, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => false,
  });

  expect(compacted.acquired).toBe(true);
  expect(await readdir(compactOwners)).toHaveLength(1);
  await compacted.release();

  const boundedPath = await lockPath('bounded.lock');
  const boundedOwners = `${boundedPath}.owners`;
  await mkdir(boundedOwners, { recursive: true });
  await Promise.all(
    Array.from({ length: 1025 }, (_, index) =>
      writeFile(join(boundedOwners, `${index + 1}-0-live-${index}.json`), ''),
    ),
  );
  await expect(
    acquireFileLock(boundedPath, { staleRequiresDeadProcess: true }),
  ).resolves.toMatchObject({ acquired: false });
});

async function lockPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-lock-'));
  roots.push(root);
  return join(root, 'locks', name);
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null)
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`contender exited ${child.exitCode}`));
  return new Promise<void>((resolve, reject) =>
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`contender exited ${code}`)),
    ),
  );
}

async function waitForChildPath(path: string, child: ReturnType<typeof spawn>): Promise<void> {
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (child.exitCode !== null)
        throw new Error(`contender exited ${child.exitCode} before writing ${path}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
}
