export function createInProcessSerialiser() {
  let prior: Promise<void> = Promise.resolve();
  return async <Value>(operation: () => Promise<Value>, signal?: AbortSignal): Promise<Value> => {
    const current = prior.then(async () => {
      throwIfAborted(signal);
      return operation();
    });
    prior = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Activation scheduler run aborted');
}
