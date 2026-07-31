import { z } from 'zod';

export const activitiesConfigSchema = z.object({}).strict();
export type ActivitiesConfig = z.infer<typeof activitiesConfigSchema>;
