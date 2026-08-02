import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWakePaths } from '../../src-next/bootstrap/paths.js';

describe('Wake paths', () => {
  it('resolves durable runtime data below the Wake root', () => {
    const paths = resolveWakePaths('C:/wake-home');

    expect(paths).toEqual({
      wakeRoot: 'C:/wake-home',
      dataRoot: join('C:/wake-home', '.wake'),
      eventsRoot: join('C:/wake-home', '.wake', 'events'),
      projectionsRoot: join('C:/wake-home', '.wake', 'projections'),
      checkpointsRoot: join('C:/wake-home', '.wake', 'checkpoints'),
      locksRoot: join('C:/wake-home', '.wake', 'locks'),
      transcriptsRoot: join('C:/wake-home', '.wake', 'transcripts'),
      containerHomeRoot: join('C:/wake-home', '.wake', 'container-home'),
      workspacesRoot: join('C:/wake-home', 'workspaces'),
    });
  });
});
