import { z } from 'zod';
import { RetrySafety } from '../../../activities/index.js';

const outcomeSchema = z.enum(['DONE', 'REJECTED', 'BLOCKED', 'FAILED']);
const matchSchema = z
  .object({
    runner: z.string().trim().min(1),
    action: z.string().trim().min(1),
    occurrence: z.number().int().positive().optional(),
  })
  .strict();
const delaySchema = z.union([
  z.number().int().positive(),
  z
    .object({
      min: z.number().int().positive(),
      max: z.number().int().positive(),
      seed: z.union([z.string().trim().min(1), z.number().int()]),
    })
    .strict()
    .refine((value) => value.min <= value.max, { message: 'min must not exceed max' }),
]);
const ruleSchema = z
  .object({
    name: z.string().trim().min(1),
    when: matchSchema,
    afterMs: delaySchema,
    outcome: outcomeSchema,
    retrySafety: z.literal(RetrySafety.SafeToRetry).optional(),
    displayBody: z.string().trim().min(1).optional(),
    reportedArtifacts: z
      .array(
        z
          .object({
            kind: z.string().trim().min(1),
            externalKey: z
              .object({ adapter: z.string().trim().min(1), key: z.string().trim().min(1) })
              .strict(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .refine((value) => value.outcome === 'FAILED' || value.retrySafety === undefined, {
    message: 'retrySafety is only valid for FAILED outcomes',
    path: ['retrySafety'],
  });

const fileSchema = z
  .object({ schemaVersion: z.literal(1), rules: z.array(ruleSchema).default([]) })
  .strict()
  .superRefine((value, context) => {
    const names = new Set<string>();
    value.rules.forEach((rule, index) => {
      if (names.has(rule.name))
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'name'],
          message: `Duplicate fake scenario rule name: ${rule.name}`,
        });
      names.add(rule.name);
    });
  });

export interface FakeScenarioMatch {
  readonly runner: string;
  readonly workflow?: string;
  readonly action: string;
  readonly occurrence: number;
}

export interface ResolvedFakeScenario {
  readonly name: string;
  readonly delayMs: number;
  readonly outcome: z.output<typeof outcomeSchema>;
  readonly retrySafety?: typeof RetrySafety.SafeToRetry;
  readonly displayBody?: string;
  readonly reportedArtifacts?: readonly {
    readonly kind: string;
    readonly externalKey: { readonly adapter: string; readonly key: string };
  }[];
}

export interface FakeScenarioResolver {
  resolve(input: FakeScenarioMatch): ResolvedFakeScenario | undefined;
}

export const emptyFakeScenarios: FakeScenarioResolver = { resolve: () => undefined };

export function parseFakeScenarios(value: unknown): FakeScenarioResolver {
  const parsed = fileSchema.parse(value);
  return {
    resolve(input) {
      const rule = parsed.rules.find(
        (candidate) =>
          candidate.when.runner === input.runner &&
          candidate.when.action === input.action &&
          (candidate.when.occurrence === undefined ||
            candidate.when.occurrence === input.occurrence),
      );
      if (rule === undefined) return undefined;
      return {
        name: rule.name,
        delayMs: resolveDelay(rule.afterMs, input),
        outcome: rule.outcome,
        ...(rule.retrySafety === undefined ? {} : { retrySafety: rule.retrySafety }),
        ...(rule.displayBody === undefined ? {} : { displayBody: rule.displayBody }),
        ...(rule.reportedArtifacts === undefined
          ? {}
          : { reportedArtifacts: rule.reportedArtifacts }),
      };
    },
  };
}

function resolveDelay(afterMs: z.output<typeof delaySchema>, input: FakeScenarioMatch): number {
  if (typeof afterMs === 'number') return afterMs;
  const range = afterMs.max - afterMs.min + 1;
  return (
    afterMs.min +
    (hash(`${afterMs.seed}:${input.runner}:${input.action}:${input.occurrence}`) % range)
  );
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}
