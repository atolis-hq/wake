export type ProcessorRunSerialiser = <Value>(
  consumer: string,
  signal: AbortSignal,
  operation: () => Promise<Value>,
) => Promise<Value>;
