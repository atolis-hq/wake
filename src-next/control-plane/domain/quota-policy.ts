export interface QuotaPolicyOptions {
  readonly maxDispatches: number;
  readonly pauseDurationMs: number;
}

export type QuotaDecision =
  | { readonly kind: 'dispatch' }
  | { readonly kind: 'pause'; readonly resumeAt: string; readonly reason: string }
  | { readonly kind: 'paused'; readonly resumeAt: string }
  | { readonly kind: 'resume' };

export class QuotaPolicy {
  constructor(private readonly options: QuotaPolicyOptions) {}

  decide(now: string, dispatches: number, pausedUntil: string | null): QuotaDecision {
    const current = parse(now);
    if (pausedUntil !== null) {
      const deadline = parse(pausedUntil);
      return current >= deadline ? { kind: 'resume' } : { kind: 'paused', resumeAt: pausedUntil };
    }
    if (dispatches < this.options.maxDispatches) return { kind: 'dispatch' };
    return {
      kind: 'pause',
      resumeAt: new Date(current + this.options.pauseDurationMs).toISOString(),
      reason: 'dispatch quota exhausted',
    };
  }
}

function parse(value: string): number {
  const result = Date.parse(value);
  if (Number.isNaN(result)) throw new Error(`Invalid quota timestamp: ${value}`);
  return result;
}
