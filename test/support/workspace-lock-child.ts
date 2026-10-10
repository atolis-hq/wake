import { workspaceLocks } from './workspace-locks.js';

const path = process.argv[2];
if (path === undefined) throw new Error('Workspace lease path is required');
const lock = await workspaceLocks.tryAcquire(path);
if (!lock.acquired) throw new Error('Fixture failed to acquire its workspace lease');
// Exit without release, modelling a dead host with a durable owner record.
process.exit(0);
