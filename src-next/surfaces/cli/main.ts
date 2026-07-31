import type { HostBudget, HostResult } from '../../control-plane/index.js';

export interface HostOptions {
  readonly host?: string;
  readonly port?: number;
  readonly wakeRoot?: string;
}

export type WakeCommand =
  | ({ readonly kind: 'tick' | 'start' | 'stop' } & { readonly wakeRoot?: string })
  | ({ readonly kind: 'api' | 'ui' } & HostOptions)
  | { readonly kind: 'audit'; readonly workItemId: string }
  | { readonly kind: 'correlate'; readonly resource: string; readonly workItemId: string }
  | { readonly kind: 'validate-state'; readonly rebuildProjections: boolean };

export interface AuditRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly stream: string;
  readonly causationId: string;
  readonly correlationId: string;
}

export interface WakeCliApplications {
  readonly tick: { run(budget: HostBudget): Promise<HostResult> };
  readonly start: { run(signal: AbortSignal, budget: HostBudget): Promise<HostResult> };
  readonly stop: { stop(): Promise<void> };
  readonly api: { start(options?: HostOptions): Promise<void> };
  readonly ui: { start(options?: HostOptions): Promise<void> };
  readonly audit: { read(workItemId: string): Promise<readonly AuditRecord[]> };
  readonly correlate: { correlate(resource: string, workItemId: string): Promise<unknown> };
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
    case 'validate-state':
      return parseValidateState(first, second);
    case 'api':
    case 'ui':
      return { kind: command, ...parseHostOptions(arguments_.slice(1)) };
    case 'tick':
    case 'start':
    case 'stop':
      return parseResidentCommand(command, arguments_.slice(1));
    default:
      throw new Error(`Unknown wake command: ${command ?? ''}`);
  }
}

function parseValidateState(first?: string, second?: string): WakeCommand {
  const allowed = first === undefined || first === '--rebuild-projections';
  if (!allowed || second !== undefined)
    throw new Error('validate-state accepts only --rebuild-projections');
  return { kind: 'validate-state', rebuildProjections: first === '--rebuild-projections' };
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

export async function runWakeCommand(
  command: WakeCommand,
  applications: WakeCliApplications,
  output: CliOutput,
  signal: AbortSignal,
): Promise<void> {
  switch (command.kind) {
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
    case 'audit':
      for (const record of await applications.audit.read(command.workItemId))
        output.write(`${JSON.stringify(record)}\n`);
      return;
    case 'correlate':
      output.write(
        `${JSON.stringify(await applications.correlate.correlate(command.resource, command.workItemId))}\n`,
      );
      return;
    case 'validate-state': {
      if (command.rebuildProjections) await applications.validateState.rebuildProjections();
      output.write(`${JSON.stringify(await applications.validateState.health())}\n`);
      return;
    }
  }
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
