import type { RuntimeEventDraft } from '../domain/types.js';
import { currentProcessIdentity } from '../lib/process-identity.js';
import type {
  AgentExecution,
  AgentRunInput,
  AgentRunResult,
  CancellationReason,
} from './contracts.js';

type QueuedEvent =
  | { kind: 'event'; event: RuntimeEventDraft }
  | { kind: 'done' }
  | { kind: 'error'; error: unknown };

function createEventQueue(): {
  push(event: RuntimeEventDraft): void;
  close(): void;
  fail(error: unknown): void;
  iterable: AsyncIterable<RuntimeEventDraft>;
} {
  const queue: QueuedEvent[] = [];
  const waiters: Array<(value: QueuedEvent) => void> = [];
  let closed = false;

  function emit(value: QueuedEvent): void {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(value);
      return;
    }
    queue.push(value);
  }

  async function nextQueued(): Promise<QueuedEvent> {
    const value = queue.shift();
    if (value !== undefined) return value;
    if (closed) return { kind: 'done' };
    return new Promise((resolve) => waiters.push(resolve));
  }

  return {
    push(event) {
      if (!closed) emit({ kind: 'event', event });
    },
    close() {
      if (closed) return;
      closed = true;
      emit({ kind: 'done' });
    },
    fail(error) {
      if (closed) return;
      closed = true;
      emit({ kind: 'error', error });
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const value = await nextQueued();
          if (value.kind === 'done') return;
          if (value.kind === 'error') throw value.error;
          yield value.event;
        }
      },
    },
  };
}

export function createAgentExecution(
  input: AgentRunInput,
  execute: (input: AgentRunInput) => Promise<AgentRunResult>,
): AgentExecution {
  const controller = new AbortController();
  const events = createEventQueue();

  const result = Promise.resolve()
    .then(() =>
      execute({
        ...input,
        cancellationSignal: controller.signal,
        onRuntimeEvent: async (event) => {
          await input.onRuntimeEvent?.(event);
          events.push(event);
        },
      }),
    )
    .then(
      (value) => {
        events.close();
        return value;
      },
      (error: unknown) => {
        events.fail(error);
        throw error;
      },
    );

  return {
    runId: input.runId,
    processIdentity: currentProcessIdentity(),
    events: events.iterable,
    async cancel(reason: CancellationReason): Promise<void> {
      controller.abort(reason);
    },
    result,
  };
}
