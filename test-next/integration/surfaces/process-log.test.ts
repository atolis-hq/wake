import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProcessLogSink } from '../../../src-next/surfaces/cli/infrastructure/process-log.js';

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
});
