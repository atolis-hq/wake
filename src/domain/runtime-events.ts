export const runtimeEventTypeValues = [
  'run.claimed',
  'run.started',
  'workspace.preparing',
  'workspace.ready',
  'agent.process.started',
  'agent.session.started',
  'agent.progress',
  'agent.tool.requested',
  'agent.approval.requested',
  'agent.input.required',
  'agent.usage.updated',
  'agent.turn.completed',
  'agent.process.exited',
  'run.completed',
  'run.failed',
  'run.stalled',
  'run.canceled',
] as const;

export type RuntimeEventType = (typeof runtimeEventTypeValues)[number];

export interface RuntimeEventRunner {
  name: string;
  kind: 'fake' | 'claude' | 'codex' | 'cursor';
  cli: string;
  model?: string;
}

export interface RuntimeEvent {
  type: RuntimeEventType;
  runId: string;
  workItemId: string;
  runner: RuntimeEventRunner;
  sessionId?: string;
  timestamp: string;
  sequence: number;
  payload: Record<string, unknown>;
}

export type RuntimeEventDraft = Omit<RuntimeEvent, 'timestamp' | 'sequence'> & {
  timestamp?: string;
  sequence?: number;
};

export function isMeaningfulRuntimeEvent(event: Pick<RuntimeEvent, 'type'>): boolean {
  return (
    event.type === 'agent.progress' ||
    event.type === 'agent.tool.requested' ||
    event.type === 'agent.approval.requested' ||
    event.type === 'agent.input.required' ||
    event.type === 'agent.usage.updated' ||
    event.type === 'agent.turn.completed'
  );
}

export function runtimeEventPayload(input: {
  message?: string;
  raw?: unknown;
  exitCode?: number;
  timedOut?: boolean;
  tokenUsage?: unknown;
}): Record<string, unknown> {
  return {
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.raw === undefined ? {} : { raw: input.raw }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.timedOut === undefined ? {} : { timedOut: input.timedOut }),
    ...(input.tokenUsage === undefined ? {} : { tokenUsage: input.tokenUsage }),
  };
}
