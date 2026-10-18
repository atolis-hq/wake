import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import YAML from 'yaml';

const execute = promisify(execFile);

it.each([false, true])(
  'runs host management and reads with unwritable runtime state (triggers: %s)',
  async (triggers) => {
    const home = await mkdtemp(join(tmpdir(), 'wake-host-read-only-'));
    const state = join(home, '.wake');
    const locks = join(state, 'locks');
    const bin = join(home, 'bin');
    const calls = join(home, 'logs', 'docker-calls');
    // Root can bypass mode bits. Use an unprivileged child in root-owned CI containers.
    const identity = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
    try {
      await chmod(home, 0o755);
      await mkdir(locks, { recursive: true });
      await mkdir(bin);
      await mkdir(join(home, 'logs'), { mode: 0o777 });
      await chmod(join(home, 'logs'), 0o777);
      await writeFile(
        join(bin, 'docker'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = container ]; then echo false; fi\nif [ "$1" = run ] && [ -e '${home}/fail-update' ]; then exit 23; fi\n`,
      );
      await chmod(join(bin, 'docker'), 0o755);
      await writeFile(
        join(home, 'config.yaml'),
        YAML.stringify({
          execution: {
            agentRunners: { fake: { kind: 'fake' } },
            runnerPools: { standard: ['fake'] },
            defaultRunnerPool: 'standard',
          },
          orchestration: {
            default: 'inspect',
            workflows: {
              inspect: {
                stages: {
                  start: {
                    activity: 'agent',
                    requiresApproval: false,
                    with: { prompt: 'Inspect' },
                    on: { done: { then: 'done' } },
                  },
                },
              },
            },
          },
          controlPlane: {
            triggers: triggers
              ? [{ id: 'oversight', workflow: 'inspect', on: { cron: '* * * * *' } }]
              : [],
          },
        }),
      );
      const lease = JSON.stringify({
        attemptId: 'failed-update',
        tag: 'test',
        phase: 'failed',
        startedAt: '2026-10-14T00:00:00.000Z',
        failure: 'test failure',
      });
      await writeFile(join(state, 'update-maintenance.json'), lease);
      await chmod(locks, 0o555);
      await chmod(state, 0o555);
      const options = {
        ...identity,
        env: { ...process.env, PATH: bin + ':' + process.env.PATH },
        timeout: 30_000,
      };
      await execute(
        process.execPath,
        [
          '-e',
          `require('node:fs').mkdir(${JSON.stringify(join(locks, 'probe'))}, error => process.exit(error?.code === 'EACCES' ? 0 : 1))`,
        ],
        options,
      );
      const cli = async (arguments_: string[]) =>
        execute(
          process.execPath,
          [
            resolve('node_modules/tsx/dist/cli.mjs'),
            '--tsconfig',
            resolve('tsconfig.source.json'),
            resolve('src/main.ts'),
            ...arguments_,
          ],
          { ...options, cwd: home },
        );
      for (const action of ['up', 'down', 'update', 'logs', 'exec']) {
        await cli([
          'sandbox',
          action,
          '--wake-root',
          home,
          ...(action === 'exec' ? ['--', 'wake', 'doctor', '--wake-root', '/wake'] : []),
        ]);
      }
      // Root must also leave no runtime files behind, even though it can bypass permissions.
      if (process.getuid?.() === 0) {
        await execute(
          process.execPath,
          [
            resolve('node_modules/tsx/dist/cli.mjs'),
            '--tsconfig',
            resolve('tsconfig.source.json'),
            resolve('src/main.ts'),
            'doctor',
            '--wake-root',
            home,
          ],
          { env: options.env, cwd: home, timeout: 30_000 },
        );
        expect(await readdir(state)).toEqual(['locks', 'update-maintenance.json']);
      }
      const doctor = await cli(['doctor', '--wake-root', home]);
      expect(JSON.parse(doctor.stdout).notices).toContainEqual(
        expect.stringContaining('Processor health unavailable'),
      );
      expect(JSON.parse(doctor.stdout)).toMatchObject({ journal: 'ok', checkpoints: 'ok' });
      expect(JSON.parse(doctor.stdout).notices).toContain(
        'Workflow "inspect" stage "start": declared outcome "blocked" has no route.',
      );
      expect(JSON.parse(doctor.stdout).failures).toContainEqual(
        expect.stringContaining('update maintenance lease is held'),
      );
      const health = await cli(['validate-state', '--wake-root', home, '--no-sandbox']);
      expect(JSON.parse(health.stdout)).toEqual({
        journal: 'ok',
        projections: 'ok',
        checkpoints: 'ok',
      });
      expect(
        (
          await execute(
            process.execPath,
            [
              resolve('node_modules/tsx/dist/cli.mjs'),
              '--tsconfig',
              resolve('tsconfig.source.json'),
              resolve('src/main.ts'),
              'audit',
              'missing-work',
            ],
            { ...options, cwd: home },
          )
        ).stdout,
      ).toBe('');
      expect(await readdir(locks)).toEqual([]);
      expect(await readdir(state)).toEqual(['locks', 'update-maintenance.json']);
      expect(await readFile(join(state, 'update-maintenance.json'), 'utf8')).toBe(lease);
      const dockerCalls = await readFile(calls, 'utf8');
      expect(dockerCalls).toContain('wake doctor --wake-root /wake');
      expect(dockerCalls).toContain(
        'wake maintenance clear --failed --wake-root /wake --no-sandbox',
      );
      // Host-side recovery must also use the runtime user's Docker exec boundary.
      await cli([
        'sandbox',
        'exec',
        '--wake-root',
        home,
        '--',
        'wake',
        'maintenance',
        'clear',
        '--failed',
        '--wake-root',
        '/wake',
        '--no-sandbox',
      ]);
      expect(await readFile(calls, 'utf8')).toContain(
        'wake maintenance clear --failed --wake-root /wake',
      );
      // An in-progress lease must never be cleared by manual sandbox replacement.
      await chmod(state, 0o755);
      const activeLease = JSON.stringify({ ...JSON.parse(lease), phase: 'updating' });
      await writeFile(join(state, 'update-maintenance.json'), activeLease);
      await chmod(state, 0o555);
      const beforeActiveUpdate = await readFile(calls, 'utf8');
      await cli(['sandbox', 'update', '--wake-root', home]);
      expect((await readFile(calls, 'utf8')).slice(beforeActiveUpdate.length)).not.toContain(
        'maintenance clear',
      );
      expect(await readFile(join(state, 'update-maintenance.json'), 'utf8')).toBe(activeLease);
      for (const invocation of ['start ', 'stop ', 'run ', 'logs ', 'exec '])
        expect(dockerCalls).toContain(invocation);
      await chmod(state, 0o755);
      await writeFile(join(state, 'update-maintenance.json'), lease);
      await chmod(state, 0o555);
      await writeFile(join(home, 'fail-update'), '');
      const beforeFailedUpdate = await readFile(calls, 'utf8');
      await expect(cli(['sandbox', 'update', '--wake-root', home])).rejects.toThrow('23');
      expect((await readFile(calls, 'utf8')).slice(beforeFailedUpdate.length)).not.toContain(
        'maintenance clear',
      );
      expect(await readFile(join(state, 'update-maintenance.json'), 'utf8')).toBe(lease);
      if (triggers) {
        for (const arguments_ of [
          ['tick'],
          ['doctor', '--rebuild-projections'],
          ['validate-state', '--rebuild-projections'],
        ])
          await expect(cli([...arguments_, '--wake-root', home, '--no-sandbox'])).rejects.toThrow(
            'EACCES',
          );
      }
    } finally {
      await chmod(state, 0o755).catch(() => undefined);
      await chmod(locks, 0o755).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);
