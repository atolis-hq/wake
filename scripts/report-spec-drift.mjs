import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Module specifications live under src/*; Eventing package surfaces are
// governed by their package manifests and architecture checks.
const check = spawn(
  process.execPath,
  [fileURLToPath(new URL('./check-specs.mjs', import.meta.url))],
  {
    stdio: 'inherit',
  },
);

await new Promise((resolve, reject) => {
  check.once('error', reject);
  check.once('close', resolve);
});
