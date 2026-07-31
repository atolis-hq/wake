import { pathToFileURL } from 'node:url';
import { createCompositionRoot, createSurfaceApplications } from './bootstrap/index.js';
import {
  parseWakeCommand,
  runWakeCommand,
  type CliOutput,
  type WakeCliApplications,
} from './surfaces/index.js';

export interface TargetMainDependencies {
  readonly compose: (wakeRoot: string) => Promise<WakeCliApplications>;
  readonly output: CliOutput;
  readonly signal: AbortSignal;
}

export async function main(
  argv = process.argv.slice(2),
  dependencies: TargetMainDependencies = productionDependencies(),
): Promise<void> {
  const command = parseWakeCommand(argv.length === 0 ? ['tick'] : argv);
  const wakeRoot =
    'wakeRoot' in command && command.wakeRoot !== undefined ? command.wakeRoot : process.cwd();
  const applications = await dependencies.compose(wakeRoot);
  await runWakeCommand(command, applications, dependencies.output, dependencies.signal);
}

function productionDependencies(): TargetMainDependencies {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  return {
    async compose(wakeRoot) {
      const root = await createCompositionRoot(wakeRoot);
      return createSurfaceApplications(root).cli;
    },
    output: { write: (value) => process.stdout.write(value) },
    signal: controller.signal,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
