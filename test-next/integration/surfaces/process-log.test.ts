import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createProcessLogSink,
  drainProcessOutput,
  type ProcessLogSink,
} from '../../../src-next/surfaces/cli/infrastructure/process-log.js';

describe('target process log sink', () => {
  it('scrubs output before teeing it to the caller and durable log file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-process-log-'));
    const output: string[] = [];
    const sink = createProcessLogSink(join(root, 'sandbox.log'), {
      write: (line) => output.push(line),
    });
    await sink.write('GITHUB_TOKEN=secret\n');
    await sink.close();
    expect(output).toEqual(['GITHUB_TOKEN=[REDACTED]\n']);
    await expect(readFile(join(root, 'sandbox.log'), 'utf8')).resolves.toBe(
      'GITHUB_TOKEN=[REDACTED]\n',
    );
  });

  it('rotates the previous log before a configured byte limit is exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-process-log-'));
    const path = join(root, 'sandbox.log');
    const sink = createProcessLogSink(path, { write: () => undefined }, { maxBytes: 8 });
    await sink.write('first\n');
    await sink.write('second\n');
    await sink.close();
    await expect(readFile(path, 'utf8')).resolves.toBe('second\n');
    await expect(readFile(`${path}.1`, 'utf8')).resolves.toBe('first\n');
  });

  it('persists a later chunk after a transient write failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-process-log-'));
    const path = join(root, 'sandbox.log');
    await mkdir(path);
    const sink = createProcessLogSink(path, { write: () => undefined });

    await expect(sink.write('lost\n')).rejects.toMatchObject({ code: 'EISDIR' });
    await rm(path, { recursive: true });
    await expect(sink.write('persisted\n')).resolves.toBeUndefined();
    await sink.close();

    await expect(readFile(path, 'utf8')).resolves.toBe('persisted\n');
  });

  it('persists late detached stdout and stderr before closing the sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-process-log-'));
    const path = join(root, 'start.log');
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr });
    const sink = createProcessLogSink(path, { write: () => undefined }, { maxBytes: 1024 });

    const drained = drainProcessOutput(child, sink, () => undefined);
    child.emit('exit', 1);
    stdout.write('stdout GITHUB_TOKEN=secret\n');
    stderr.write('late stderr github_pat_secret\n');
    stdout.end();
    stderr.end();
    child.emit('close', 1);

    await drained;
    await expect(readFile(path, 'utf8')).resolves.toBe(
      'stdout GITHUB_TOKEN=[REDACTED]\nlate stderr [REDACTED]\n',
    );
  });

  it('reports detached sink failures without leaving a rejected drain promise', async () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr: null });
    const errors: string[] = [];
    const sink: ProcessLogSink = {
      write: async () => {
        throw new Error('disk unavailable');
      },
      close: async () => {
        throw new Error('close unavailable');
      },
    };

    const drained = drainProcessOutput(child, sink, (error) => errors.push(String(error)));
    stdout.end('late output\n');
    child.emit('close', 1);

    await expect(drained).resolves.toBeUndefined();
    expect(errors).toEqual(['Error: disk unavailable', 'Error: close unavailable']);
  });
});
