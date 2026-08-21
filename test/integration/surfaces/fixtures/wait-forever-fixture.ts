import { waitForever } from '../../../../src/surfaces/cli/commands/sandbox-entrypoint.js';

// Nothing else keeps this process alive, matching production: spawnDetached
// unref's the supervised child, so this awaited call is the only thing that
// should be able to hold the event loop open.
console.log('ready');
await waitForever();
console.log('unreachable');
