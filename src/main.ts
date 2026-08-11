import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCompositionRoot,
  createSurfaceApplications,
  initialiseWakeRoot,
  loadConfig,
  wakeVersion,
} from './bootstrap/index.js';
import {
  parseWakeCommand,
  runWakeCommand,
  sandboxUsage,
  usage,
  type CliOutput,
  type WakeCliApplications,
} from './surfaces/index.js';

export interface TargetMainDependencies {
  readonly compose: (wakeRoot: string) => Promise<WakeCliApplications>;
  readonly initialise?: (wakeRoot: string) => Promise<unknown>;
  readonly sandboxRuntime?: SandboxRuntimeRouter;
  readonly output: CliOutput;
  readonly signal: AbortSignal;
}

export interface SandboxRuntimeRouter {
  hasDockerfile(wakeRoot: string): Promise<boolean>;
  exec(wakeRoot: string, arguments_: readonly string[]): Promise<void>;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies?: TargetMainDependencies,
): Promise<void> {
  const suppliedArguments = normalizeDeveloperAlias(argv);
  const output = dependencies?.output ?? productionOutput();
  if (writePrecompositionCommand(suppliedArguments, output)) return;
  const resolvedDependencies = dependencies ?? productionDependencies();
  const bypassSandbox = suppliedArguments.includes('--no-sandbox');
  const command = parseWakeCommand(
    suppliedArguments.filter((argument) => argument !== '--no-sandbox'),
  );
  const wakeRoot = resolveWakeRoot(command);
  if (command.kind === 'init') {
    const result = await (resolvedDependencies.initialise ?? initialiseWakeRoot)(wakeRoot);
    resolvedDependencies.output.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (resolvedDependencies.sandboxRuntime !== undefined) {
    const sandboxRuntime = resolvedDependencies.sandboxRuntime;
    const ranInSandbox = await runInSandboxIfAvailable({
      commandKind: command.kind,
      bypassSandbox,
      hasDockerfile: () => sandboxRuntime.hasDockerfile(wakeRoot),
      exec: () => sandboxRuntime.exec(wakeRoot, rewriteSandboxArguments(suppliedArguments)),
    });
    if (ranInSandbox) return;
  }
  const applications = await resolvedDependencies.compose(wakeRoot);
  if (applications.sandboxRuntime !== undefined) {
    const sandboxRuntime = applications.sandboxRuntime;
    const ranInSandbox = await runInSandboxIfAvailable({
      commandKind: command.kind,
      bypassSandbox,
      hasDockerfile: () => sandboxRuntime.hasDockerfile(),
      exec: () => sandboxRuntime.exec(rewriteSandboxArguments(suppliedArguments)),
    });
    if (ranInSandbox) return;
  }
  await runWakeCommand(
    command,
    applications,
    resolvedDependencies.output,
    resolvedDependencies.signal,
  );
}

function normalizeDeveloperAlias(arguments_: readonly string[]): readonly string[] {
  if (arguments_[0] !== 'dev' || arguments_[1] !== 'sandbox') return arguments_;
  return ['sandbox', ...arguments_.slice(2)];
}

function writePrecompositionCommand(arguments_: readonly string[], output: CliOutput): boolean {
  return writeMetaCommand(arguments_, output) || writeSandboxHelpCommand(arguments_, output);
}

function writeMetaCommand(arguments_: readonly string[], output: CliOutput): boolean {
  if (isHelpCommand(arguments_)) {
    output.write(`${usage}\n`);
    return true;
  }
  if (isVersionCommand(arguments_)) {
    output.write(`${wakeVersion}\n`);
    return true;
  }
  return false;
}

function writeSandboxHelpCommand(arguments_: readonly string[], output: CliOutput): boolean {
  if (arguments_[0] !== 'sandbox') return false;
  if (arguments_.length !== 1 && !['--help', '-h', 'help'].includes(arguments_[1] ?? ''))
    return false;
  output.write(`${sandboxUsage}\n`);
  return true;
}

function isHelpCommand(arguments_: readonly string[]): boolean {
  return arguments_.length === 0 || ['--help', '-h', 'help'].includes(arguments_[0] ?? '');
}

function isVersionCommand(arguments_: readonly string[]): boolean {
  return ['--version', '-v'].includes(arguments_[0] ?? '');
}

function resolveWakeRoot(command: Parameters<typeof runWakeCommand>[0]): string {
  if ('wakeRoot' in command && command.wakeRoot !== undefined) return command.wakeRoot;
  if ('arguments' in command) {
    const explicitWakeRoot = operationalWakeRoot(command.arguments);
    if (explicitWakeRoot !== undefined) return explicitWakeRoot;
    if (command.kind === 'init') return initWakeRoot(command.arguments) ?? process.cwd();
  }
  return process.cwd();
}

function initWakeRoot(arguments_: readonly string[]): string | undefined {
  const positional = arguments_[0];
  return positional !== undefined && !positional.startsWith('--') ? positional : undefined;
}

async function runInSandboxIfAvailable(input: {
  readonly commandKind: string;
  readonly bypassSandbox: boolean;
  readonly hasDockerfile: () => Promise<boolean>;
  readonly exec: () => Promise<void>;
}): Promise<boolean> {
  if (input.bypassSandbox || !isRuntimeCommand(input.commandKind)) return false;
  if (!(await input.hasDockerfile())) return false;
  await input.exec();
  return true;
}

function isRuntimeCommand(kind: string): boolean {
  return ['tick', 'start', 'ui', 'smoke', 'audit', 'correlate', 'validate-state'].includes(kind);
}

function rewriteSandboxArguments(arguments_: readonly string[]): readonly string[] {
  const withoutBypass = arguments_.filter((argument) => argument !== '--no-sandbox');
  const wakeRootIndex = withoutBypass.indexOf('--wake-root');
  const rewritten =
    wakeRootIndex === -1
      ? [...withoutBypass, '--wake-root', '/wake']
      : withoutBypass.map((argument, index) => (index === wakeRootIndex + 1 ? '/wake' : argument));
  return [...rewritten, '--no-sandbox'];
}

function operationalWakeRoot(arguments_: readonly string[]): string | undefined {
  const index = arguments_.indexOf('--wake-root');
  return index === -1 ? undefined : arguments_[index + 1];
}

function productionDependencies(): TargetMainDependencies {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  return {
    initialise: initialiseWakeRoot,
    sandboxRuntime: productionSandboxRuntime(),
    async compose(wakeRoot) {
      const root = await createCompositionRoot(wakeRoot);
      return createSurfaceApplications(root).cli;
    },
    output: productionOutput(),
    signal: controller.signal,
  };
}

function productionOutput(): CliOutput {
  return { write: (value) => process.stdout.write(value) };
}

function productionSandboxRuntime(): SandboxRuntimeRouter {
  return {
    async hasDockerfile(wakeRoot) {
      try {
        await access(join(wakeRoot, 'docker', 'Dockerfile'));
        return true;
      } catch {
        return false;
      }
    },
    async exec(wakeRoot, arguments_) {
      const config = await loadConfig(wakeRoot);
      const invocation =
        config.host.development.mode === 'source' ? ['node', '/app/dist/src/main.js'] : ['wake'];
      await runDocker([
        'exec',
        '-i',
        config.host.sandbox.containerName,
        ...invocation,
        ...arguments_,
      ]);
    },
  };
}

function runDocker(arguments_: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', arguments_, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('docker ' + arguments_.join(' ') + ' exited with code ' + String(code))),
    );
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
