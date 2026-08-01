import type { ExecutionFailure } from '../contracts/views.js';
import { ExecutionFailureCode } from '../contracts/vocabulary.js';

export function failureFrom(error: unknown): ExecutionFailure {
  const source = sourceFailure(error);
  return {
    kind: ExecutionFailureCode.Unexpected,
    message: source.message,
    details: {
      sourceKind: source.kind,
      ...(source.details === undefined ? {} : { sourceDetails: source.details }),
    },
  };
}

function sourceFailure(error: unknown): {
  readonly kind: string;
  readonly message: string;
  readonly details?: unknown;
} {
  if (error instanceof Error)
    return {
      kind: error.name,
      message: error.message,
      ...('details' in error ? { details: error.details } : {}),
    };
  if (typeof error === 'object' && error !== null) {
    const kind = Reflect.get(error, 'kind');
    const message = Reflect.get(error, 'message');
    const details = Reflect.get(error, 'details');
    return {
      kind: typeof kind === 'string' && kind.length > 0 ? kind : 'non-error-object',
      message: typeof message === 'string' ? message : failureValue(error),
      ...(details === undefined ? {} : { details }),
    };
  }
  return { kind: typeof error, message: failureValue(error) };
}

function failureValue(error: unknown): string {
  return typeof error === 'symbol' ? error.toString() : `${error}`;
}
