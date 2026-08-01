import { z } from 'zod';
import { ActivityExecutionKind, BuiltInActivityName } from '../contracts/vocabulary.js';
import type { ActivityDefinition } from '../contracts/activity.js';
import { createAgentActivity } from './agent-activity.js';
import {
  agentActivityOutcomeKinds,
  agentActivityOutcomeSchema,
  type AgentActivityOutcome,
} from './agent-result.js';

export const agentActivityDefinition: ActivityDefinition<
  typeof BuiltInActivityName.Agent,
  { prompt: string; model?: string | undefined; allowedTools?: readonly string[] | undefined },
  AgentActivityOutcome
> = {
  name: BuiltInActivityName.Agent,
  inputSchema: z
    .object({
      prompt: z.string().min(1),
      model: z.string().min(1).optional(),
      allowedTools: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  outcomeSchema: agentActivityOutcomeSchema,
  outcomeKinds: agentActivityOutcomeKinds,
  resources: [],
  executionKind: ActivityExecutionKind.Agent,
  handler: createAgentActivity(),
};
