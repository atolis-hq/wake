import { z } from 'zod';

const isReservedFlag = (arg: string) => arg === '--output-format' || arg === '--resume';
const agentRunnerBase = {
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().positive().default(1_800_000),
  args: z.array(z.string()).default([]),
};
const commandRunner = (kind: string) =>
  z
    .object({ kind: z.literal(kind), command: z.string().trim().min(1), ...agentRunnerBase })
    .strict();

export const executionConfigSchema = z
  .object({
    agentRunners: z
      .record(
        z.string().trim().min(1),
        z
          .discriminatedUnion('kind', [
            commandRunner('claude-cli'),
            commandRunner('codex-cli'),
            commandRunner('cursor-cli'),
            commandRunner('command'),
            z.object({ kind: z.literal('fake'), ...agentRunnerBase }).strict(),
          ])
          .refine((value) => !value.args.some(isReservedFlag), {
            message: 'args must not contain --output-format or --resume',
          }),
      )
      .default({}),
    runnerPools: z
      .record(z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1))
      .default({}),
    defaultRunnerPool: z.string().trim().min(1),
    leaseDurationMs: z.number().int().positive().optional(),
    leaseRenewalIntervalMs: z.number().int().positive().optional(),
  })
  .strict();

export interface ExecutionConfig {
  readonly agentRunners?: Readonly<
    Record<
      string,
      {
        readonly kind: 'claude-cli' | 'codex-cli' | 'cursor-cli' | 'command' | 'fake';
        readonly command?: string;
        readonly model?: string;
        readonly effort?: string;
        readonly timeoutMs: number;
        readonly args: readonly string[];
      }
    >
  >;
  readonly runnerPools: Readonly<Record<string, readonly string[]>>;
  readonly defaultRunnerPool: string;
  readonly leaseDurationMs?: number;
  readonly leaseRenewalIntervalMs?: number;
}
