import { z } from 'zod';

/** Operator-supplied task context, never inferred from ticket text. */
export const deliveryOversightInputSchema = z
  .object({
    repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).min(1),
    focus: z.string().min(1).optional(),
  })
  .strict();

export type DeliveryOversightInput = z.infer<typeof deliveryOversightInputSchema>;
