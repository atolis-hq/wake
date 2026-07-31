import { z } from 'zod';

export const resourcesConfigSchema = z.object({}).strict();
export type ResourcesConfig = z.infer<typeof resourcesConfigSchema>;
