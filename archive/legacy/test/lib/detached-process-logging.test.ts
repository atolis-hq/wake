import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createDetachedProcessLogSink } from '../../src/lib/detached-process-logging.js';

describe('createDetachedProcessLogSink', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tees process output to the log file and stdout', async () => {
    const dir = join(tmpdir(), `wake-detached-log-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);

    const logFile = join(dir, 'start.log');
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));

    const sink = createDetachedProcessLogSink(logFile, {
      maxBytes: 1024,
      rotateCheckIntervalMs: 60_000,
      stdout,
    });

    sink.write('line one\n');
    sink.write('line two\n');
    await sink.close();

    expect(readFileSync(logFile, 'utf-8')).toBe('line one\nline two\n');
    expect(stdoutChunks.join('')).toBe('line one\nline two\n');
  });
});
