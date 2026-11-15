import { z } from 'zod';

export const observedStreamsSchema = z
  .array(
    z
      .object({
        stream: z.object({ kind: z.string().min(1), id: z.string().min(1) }).strict(),
        version: z.number().int().nonnegative(),
      })
      .strict(),
  )
  .min(1);

export type ObservedStream = z.infer<typeof observedStreamsSchema>[number];
