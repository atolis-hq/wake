import { readFile } from 'node:fs/promises';
import qrcode from 'qrcode-terminal';
import type { HostBudget, HostResult } from '../../control-plane/index.js';
import { ExecutionStreamKind, RunStatus } from '../../execution/index.js';

export interface HostOptions {
  readonly host?: string;
  readonly port?: number;
  readonly wakeRoot?: string;
}

export type WakeCommand =
  | ({ readonly kind: 'tick' | 'start' | 'stop' } & { readonly wakeRoot?: string })
  | ({ readonly kind: 'api' | 'ui' } & HostOptions)
  | { readonly kind: 'ui-token'; readonly wakeRoot?: string; readonly accessKey?: string }
  | { readonly kind: 'audit'; readonly workItemId: string }
  | { readonly kind: 'correlate'; readonly resource: string; readonly workItemId: string }
  | {
      readonly kind: 'run-resolve';
      readonly runId: string;
      readonly resolution:
        | {
            readonly status: typeof RunStatus.Succeeded;
            readonly outcome?: unknown;
            readonly outcomeFile?: string;
          }
        | { readonly status: typeof RunStatus.Failed; readonly reason: string };
    }
  | {
      readonly kind: 'validate-state';
      readonly rebuildProjections: boolean;
      readonly wakeRoot?: string;
    }
  | {
      readonly kind:
        'init' | 'doctor' | 'sandbox-setup' | 'sandbox-entrypoint' | 'self-update' | 'smoke';
      readonly arguments: readonly string[];
    }
  | { readonly kind: 'sandbox'; readonly arguments: readonly string[] };

export interface AuditRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly stream: string;
  readonly causationId: string;
  readonly correlationId: string;
}

export interface WakeCliApplications {
  readonly sandboxRuntime?: {
    hasDockerfile(): Promise<boolean>;
    exec(arguments_: readonly string[]): Promise<void>;
  };
  readonly operational?: {
    readonly init: (arguments_: readonly string[]) => Promise<unknown>;
    readonly doctor: (arguments_: readonly string[]) => Promise<unknown>;
    readonly sandbox: (arguments_: readonly string[]) => Promise<unknown>;
    readonly sandboxSetup: (arguments_: readonly string[]) => Promise<unknown>;
    readonly sandboxEntrypoint: (arguments_: readonly string[]) => Promise<unknown>;
    readonly selfUpdate: (arguments_: readonly string[]) => Promise<unknown>;
    readonly smoke: (arguments_: readonly string[]) => Promise<unknown>;
  };
  readonly tick: { run(budget: HostBudget): Promise<HostResult> };
  readonly start: { run(signal: AbortSignal, budget: HostBudget): Promise<HostResult> };
  readonly stop: { stop(): Promise<void> };
  readonly api: { start(options?: HostOptions): Promise<void> };
  readonly ui: { start(options?: HostOptions): Promise<void> };
  readonly auth?: { token(accessKey?: string): Promise<string> };
  readonly audit: { read(workItemId: string): Promise<readonly AuditRecord[]> };
  readonly correlate: { correlate(resource: string, workItemId: string): Promise<unknown> };
  readonly runs?: {
    resolve(
      runId: string,
      resolution:
        | { readonly status: typeof RunStatus.Succeeded; readonly outcome: unknown }
        | { readonly status: typeof RunStatus.Failed; readonly reason: string },
    ): Promise<unknown>;
  };
  readonly validateState: {
    health(): Promise<{
      readonly journal: string;
      readonly projections: string;
      readonly checkpoints: string;
    }>;
    rebuildProjections(): Promise<void>;
  };
}

export interface CliOutput {
  write(value: string): void;
}

const defaultBudget: HostBudget = { maxAdvances: 100, maxRuns: 100, maxDurationMs: 30_000 };

/** Parses Surface vocabulary only; Bootstrap supplies every application facade. */
// eslint-disable-next-line complexity -- command vocabulary is intentionally exhaustive at the Surface boundary.
export function parseWakeCommand(arguments_: readonly string[]): WakeCommand {
  const [command, first, second] = arguments_;
  switch (command) {
    case 'audit':
      return { kind: 'audit', workItemId: requiredArgument(first, 'audit work item') };
    case 'correlate':
      return {
        kind: 'correlate',
        resource: requiredArgument(first, 'correlate resource'),
        workItemId: requiredArgument(second, 'correlate work item'),
      };
    case ExecutionStreamKind.Run:
      return parseRunCommand(arguments_.slice(1));
    case 'validate-state':
      return parseValidateState(arguments_.slice(1));
    case 'api':
      return { kind: command, ...parseHostOptions(arguments_.slice(1)) };
    case 'ui':
      if (first === 'token') return parseUiToken(arguments_.slice(2));
      return { kind: command, ...parseHostOptions(arguments_.slice(1)) };
    case 'tick':
    case 'start':
    case 'stop':
      return parseResidentCommand(command, arguments_.slice(1));
    case 'init':
    case 'doctor':
    case 'sandbox-setup':
    case 'sandbox-entrypoint':
    case 'sandbox':
    case 'self-update':
    case 'smoke':
      return { kind: command, arguments: arguments_.slice(1) };
    default:
      throw new Error(`Unknown wake command: ${command ?? ''}`);
  }
}

function parseUiToken(arguments_: readonly string[]): WakeCommand {
  if (arguments_[0] === 'set') {
    const accessKey = requiredArgument(arguments_[1], 'UI access key');
    if (arguments_.length !== 2) throw new Error('ui token set accepts exactly one access key');
    return { kind: 'ui-token', accessKey };
  }
  if (arguments_.length === 0) return { kind: 'ui-token' };
  if (arguments_.length === 2 && arguments_[0] === '--wake-root')
    return { kind: 'ui-token', wakeRoot: requiredArgument(arguments_[1], '--wake-root path') };
  throw new Error('ui token accepts optional --wake-root <path>');
}

// eslint-disable-next-line complexity -- the resolution flags are mutually exclusive by design.
function parseRunCommand(arguments_: readonly string[]): WakeCommand {
  if (arguments_[0] !== 'resolve') throw new Error(`Unknown run command: ${arguments_[0] ?? ''}`);
  const runId = requiredArgument(arguments_[1], 'run id');
  const values = new Map<string, string>();
  for (let index = 2; index < arguments_.length; index += 1) {
    const flag = arguments_[index]!;
    if (flag === '--succeeded' || flag === '--failed') {
      if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      values.set(flag, '');
      continue;
    }
    if (flag !== '--outcome' && flag !== '--outcome-file' && flag !== '--reason')
      throw new Error(`Unknown option: ${flag}`);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const succeeded = values.has('--succeeded');
  const failed = values.has('--failed');
  if (succeeded === failed)
    throw new Error('run resolve requires exactly one of --succeeded or --failed');
  if (succeeded) {
    const outcome = values.get('--outcome');
    const outcomeFile = values.get('--outcome-file');
    if ((outcome === undefined) === (outcomeFile === undefined))
      throw new Error('Successful resolution requires exactly one of --outcome or --outcome-file');
    if (values.has('--reason')) throw new Error('--reason is only valid with --failed');
    return {
      kind: 'run-resolve',
      runId,
      resolution:
        outcome === undefined
          ? { status: RunStatus.Succeeded, outcomeFile: outcomeFile! }
          : { status: RunStatus.Succeeded, outcome: parseJson(outcome) },
    };
  }
  if (values.has('--outcome') || values.has('--outcome-file'))
    throw new Error('--outcome and --outcome-file are only valid with --succeeded');
  const reason = values.get('--reason');
  if (reason === undefined || reason.trim() === '')
    throw new Error('Failed resolution requires --reason <message>');
  return { kind: 'run-resolve', runId, resolution: { status: RunStatus.Failed, reason } };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Outcome must be valid JSON');
  }
}

function parseValidateState(arguments_: readonly string[]): WakeCommand {
  let rebuildProjections = false;
  let wakeRoot: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--rebuild-projections' && !rebuildProjections) {
      rebuildProjections = true;
      continue;
    }
    if (argument === '--wake-root') {
      wakeRoot = requiredArgument(arguments_[index + 1], 'value for --wake-root');
      index += 1;
      continue;
    }
    throw new Error('validate-state accepts only --rebuild-projections and --wake-root <path>');
  }
  return {
    kind: 'validate-state',
    rebuildProjections,
    ...(wakeRoot === undefined ? {} : { wakeRoot }),
  };
}

function parseResidentCommand(
  kind: 'tick' | 'start' | 'stop',
  arguments_: readonly string[],
): WakeCommand {
  const options = parseHostOptions(arguments_, false);
  return { kind, ...(options.wakeRoot === undefined ? {} : { wakeRoot: options.wakeRoot }) };
}

function requiredArgument(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

// eslint-disable-next-line complexity -- each parsed command has one explicit application dispatch.
export async function runWakeCommand(
  command: WakeCommand,
  applications: WakeCliApplications,
  output: CliOutput,
  signal: AbortSignal,
): Promise<void> {
  switch (command.kind) {
    case 'init':
      writeResult(output, await operational(applications).init(command.arguments));
      return;
    case 'doctor':
      writeResult(output, await operational(applications).doctor(command.arguments));
      return;
    case 'sandbox':
      writeResult(output, await operational(applications).sandbox(command.arguments));
      return;
    case 'sandbox-setup':
      writeResult(output, await operational(applications).sandboxSetup(command.arguments));
      return;
    case 'sandbox-entrypoint':
      await operational(applications).sandboxEntrypoint(command.arguments);
      return;
    case 'self-update':
      writeResult(output, await operational(applications).selfUpdate(command.arguments));
      return;
    case 'smoke':
      writeResult(output, await operational(applications).smoke(command.arguments));
      return;
    case 'tick':
      output.write(`${JSON.stringify(await applications.tick.run(defaultBudget))}\n`);
      return;
    case 'start':
      output.write(`${JSON.stringify(await applications.start.run(signal, defaultBudget))}\n`);
      return;
    case 'stop':
      await applications.stop.stop();
      return;
    case 'api':
      await applications.api.start(command);
      return;
    case 'ui':
      await applications.ui.start(command);
      return;
    case 'ui-token':
      writeUiToken(output, await auth(applications).token(command.accessKey));
      return;
    case 'audit':
      for (const record of await applications.audit.read(command.workItemId))
        output.write(`${JSON.stringify(record)}\n`);
      return;
    case 'correlate':
      output.write(
        `${JSON.stringify(await applications.correlate.correlate(command.resource, command.workItemId))}\n`,
      );
      return;
    case 'run-resolve':
      output.write(
        `${JSON.stringify(await runs(applications).resolve(command.runId, await resolveCliOutcome(command.resolution)))}\n`,
      );
      return;
    case 'validate-state': {
      if (command.rebuildProjections) await applications.validateState.rebuildProjections();
      output.write(`${JSON.stringify(await applications.validateState.health())}\n`);
      return;
    }
  }
}

function writeUiToken(output: CliOutput, accessKey: string): void {
  output.write(`${accessKey}\n`);
  const lines: string[] = [];
  qrcode.generate(accessKey, { small: true }, (line: string) => lines.push(line));
  output.write(`${lines.join('\n')}\n`);
}

function auth(applications: WakeCliApplications): NonNullable<WakeCliApplications['auth']> {
  if (applications.auth === undefined) throw new Error('Auth CLI application was not composed');
  return applications.auth;
}

async function resolveCliOutcome(
  resolution: Extract<WakeCommand, { readonly kind: 'run-resolve' }>['resolution'],
): Promise<
  | { readonly status: typeof RunStatus.Succeeded; readonly outcome: unknown }
  | { readonly status: typeof RunStatus.Failed; readonly reason: string }
> {
  if (resolution.status === RunStatus.Failed) return resolution;
  return {
    status: RunStatus.Succeeded,
    outcome:
      resolution.outcomeFile === undefined
        ? resolution.outcome
        : parseJson(await readFile(resolution.outcomeFile, 'utf8')),
  };
}

function runs(applications: WakeCliApplications): NonNullable<WakeCliApplications['runs']> {
  if (applications.runs === undefined) throw new Error('Run CLI applications were not composed');
  return applications.runs;
}

function writeResult(output: CliOutput, value: unknown): void {
  if (value !== undefined) output.write(`${JSON.stringify(value)}\n`);
}

function operational(
  applications: WakeCliApplications,
): NonNullable<WakeCliApplications['operational']> {
  if (applications.operational === undefined)
    throw new Error('Operational CLI applications were not composed');
  return applications.operational;
}

function parseHostOptions(arguments_: readonly string[], allowNetwork = true): HostOptions {
  const options: { host?: string; port?: number; wakeRoot?: string } = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag ?? 'option'}`);
    applyHostOption(options, flag, value, allowNetwork);
  }
  return options;
}

function applyHostOption(
  options: { host?: string; port?: number; wakeRoot?: string },
  flag: string | undefined,
  value: string,
  allowNetwork: boolean,
): void {
  if (flag === '--wake-root') options.wakeRoot = value;
  else if (allowNetwork && flag === '--host') options.host = value;
  else if (allowNetwork && flag === '--port') options.port = parsePort(value);
  else throw new Error(`Unknown option: ${flag}`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535)
    throw new Error('Port must be a positive integer');
  return port;
}
