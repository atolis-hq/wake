import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeTranscript } from '../../src-next/execution/index.js';

describe('writeTranscript', () => {
  it('retains a runner transcript under the supplied transcript directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-transcript-'));
    const path = await writeTranscript(root, 'run-1', 'response', 'DONE');

    expect(await readFile(path, 'utf8')).toBe('DONE');
  });
});
