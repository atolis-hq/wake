import type { EntityRef } from '../../kernel/index.js';
import type { RunId } from './identifiers.js';

export const ExecutionStreamKind = { Run: 'run' } as const;

export type RunStreamRef = EntityRef<typeof ExecutionStreamKind.Run, RunId>;

export const runStream = (id: RunId): RunStreamRef => ({
  kind: ExecutionStreamKind.Run,
  id,
});

export const isRunStream = (stream: EntityRef): stream is RunStreamRef =>
  stream.kind === ExecutionStreamKind.Run;
