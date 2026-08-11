import { z } from 'zod';
import type { ActivityDefinition } from '../contracts/activity.js';
import { ActivityExecutionKind, BuiltInActivityName } from '../contracts/vocabulary.js';
import { createAgentActivity } from './agent-activity.js';
import {
  agentActivityOutcomeKinds,
  agentActivityOutcomeSchema,
  type AgentActivityOutcome,
} from './agent-result.js';

export const agentActivityDefinition: ActivityDefinition<
  typeof BuiltInActivityName.Agent,
  {
    prompt?: string | undefined;
    template?: string | undefined;
    model?: string | undefined;
    allowedTools?: readonly string[] | undefined;
  },
  AgentActivityOutcome
> = {
  name: BuiltInActivityName.Agent,
  inputSchema: z
    .object({
      prompt: z.string().min(1).optional(),
      template: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/i)
        .optional(),
      model: z.string().min(1).optional(),
      allowedTools: z.array(z.string().min(1)).optional(),
    })
    .refine((value) => (value.prompt === undefined) !== (value.template === undefined), {
      message: 'Agent Activity requires exactly one of prompt or template',
    })
    .strict(),
  outcomeSchema: agentActivityOutcomeSchema,
  outcomeKinds: agentActivityOutcomeKinds,
  resources: [],
  executionKind: ActivityExecutionKind.Agent,
  handler: createAgentActivity(),
};
