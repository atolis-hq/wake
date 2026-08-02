import { join } from 'node:path';

export interface WakePaths {
  readonly wakeRoot: string;
  readonly dataRoot: string;
  readonly eventsRoot: string;
  readonly projectionsRoot: string;
  readonly checkpointsRoot: string;
  readonly locksRoot: string;
  readonly transcriptsRoot: string;
  readonly containerHomeRoot: string;
  readonly workspacesRoot: string;
}

export function resolveWakePaths(wakeRoot: string): WakePaths {
  const dataRoot = join(wakeRoot, '.wake');
  return {
    wakeRoot,
    dataRoot,
    eventsRoot: join(dataRoot, 'events'),
    projectionsRoot: join(dataRoot, 'projections'),
    checkpointsRoot: join(dataRoot, 'checkpoints'),
    locksRoot: join(dataRoot, 'locks'),
    transcriptsRoot: join(dataRoot, 'transcripts'),
    containerHomeRoot: join(dataRoot, 'container-home'),
    workspacesRoot: join(wakeRoot, 'workspaces'),
  };
}
