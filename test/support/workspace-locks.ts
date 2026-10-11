import { acquireFileLock } from '@atolis-hq/eventing-filesystem';
import type { WorkspaceLockProvider } from '../../src/execution/index.js';

export const workspaceLocks: WorkspaceLockProvider = {
  tryAcquire: (path) =>
    acquireFileLock(path, {
      staleAfterMs: 0,
      staleRequiresDeadProcess: true,
    }),
};
