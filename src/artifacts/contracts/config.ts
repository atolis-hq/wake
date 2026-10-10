import { z } from 'zod';

export const artifactsConfigSchema = z
  .object({
    maxWriteBytes: z
      .number()
      .int()
      .positive()
      .default(25 * 1024 * 1024),
    maxWorkItemBytes: z
      .number()
      .int()
      .positive()
      .default(250 * 1024 * 1024),
  })
  .strict()
  .refine((value) => value.maxWorkItemBytes >= value.maxWriteBytes, {
    message: 'artifacts.maxWorkItemBytes must be at least artifacts.maxWriteBytes',
    path: ['maxWorkItemBytes'],
  });

export type ArtifactsConfig = z.infer<typeof artifactsConfigSchema>;
