import type { ActivationId } from '../../activities/index.js';
import type { EntityRef } from '../../kernel/index.js';
import type { RunId } from './identifiers.js';

export const ExecutionStreamKind = { Run: 'run', Activation: 'execution-activation' } as const;

export type RunStreamRef = EntityRef<typeof ExecutionStreamKind.Run, RunId>;

export const runStream = (id: RunId): RunStreamRef => ({
  kind: ExecutionStreamKind.Run,
  id,
});

export const isRunStream = (stream: EntityRef): stream is RunStreamRef =>
  stream.kind === ExecutionStreamKind.Run;

export type ActivationStreamRef = EntityRef<typeof ExecutionStreamKind.Activation, ActivationId>;

export const activationStream = (id: ActivationId): ActivationStreamRef => ({
  kind: ExecutionStreamKind.Activation,
  id,
});
