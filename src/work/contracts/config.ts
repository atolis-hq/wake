import { z } from 'zod';

export const workConfigSchema = z.object({}).strict();

export type WorkConfig = z.infer<typeof workConfigSchema>;
