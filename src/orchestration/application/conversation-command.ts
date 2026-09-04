import type { CommandContext } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../../activities/index.js';
import type { CommandPolicyConfig } from '../contracts/config.js';
import { type WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  ConversationBuiltInCommand,
  ConversationSurfaceCapability,
} from '../contracts/vocabulary.js';
import {
  isGroupBudgetExtensionEligible,
  isOperatorRetryEligible,
  selectOperatorRetryTarget,
} from '../domain/operator-retry-policy.js';

export const BuiltInConversationCommands = Object.values(ConversationBuiltInCommand);

export type SurfaceCapability = ConversationSurfaceCapability;

export type ConversationCommandSurface = { readonly capabilities: readonly SurfaceCapability[] };

export function resolveSurfaceCapabilities(
  surface: string,
  policy: CommandPolicyConfig | undefined,
  defaults: readonly SurfaceCapability[] = [],
): readonly SurfaceCapability[] {
  const configured = policy?.capabilities[surface];
  if (configured === undefined) return defaults;
  return [...new Set([...(policy?.replace ? [] : defaults), ...configured])];
}

export function conversationCommand(body: string): string | null {
  const line = body.trim().split('\n', 1)[0]?.trim().toLowerCase() ?? '';
  return /^\/[a-z][a-z0-9-]*(?:\s.*)?$/.test(line) ? line.split(/\s/, 1)[0]! : null;
}

// The command matrix is intentionally explicit so future built-ins cannot silently inherit power.
// eslint-disable-next-line complexity
export async function applyBuiltInConversationCommand(input: {
  readonly command: string;
  readonly capabilities: readonly SurfaceCapability[];
  readonly workflows: readonly WorkflowInstanceView[];
  readonly context: CommandContext;
  readonly acceptSignal: (
    id: WorkflowInstanceId,
    outcome: typeof ActivityOutcomeKind.Done | typeof ActivityOutcomeKind.Rejected,
  ) => Promise<unknown>;
  readonly retry: (id: WorkflowInstanceId) => Promise<unknown>;
  readonly restart: (id: WorkflowInstanceId) => Promise<unknown>;
  readonly extend: (id: WorkflowInstanceId) => Promise<unknown>;
  readonly resumeChanges: (id: WorkflowInstanceId) => Promise<unknown>;
}): Promise<boolean> {
  if (!BuiltInConversationCommands.includes(input.command as ConversationBuiltInCommand))
    return false;
  if (
    !input.capabilities.includes(ConversationSurfaceCapability.Review) &&
    !input.capabilities.includes(ConversationSurfaceCapability.Operator)
  )
    return false;
  if (
    input.command === ConversationBuiltInCommand.Approved ||
    input.command === ConversationBuiltInCommand.Accepted ||
    input.command === ConversationBuiltInCommand.Changes
  ) {
    const outcome =
      input.command === ConversationBuiltInCommand.Changes
        ? ActivityOutcomeKind.Rejected
        : ActivityOutcomeKind.Done;
    for (const workflow of input.workflows) {
      if (workflow.waitingFor !== undefined)
        await input.acceptSignal(workflow.workflowInstanceId, outcome);
      else if (input.command === ConversationBuiltInCommand.Changes)
        await input.resumeChanges(workflow.workflowInstanceId);
    }
    return true;
  }
  if (input.command === ConversationBuiltInCommand.Retry) {
    const target = selectOperatorRetryTarget(input.workflows);
    if (target !== undefined) await input.retry(target.workflowInstanceId);
    return true;
  }
  const primary = input.workflows.find(
    (workflow) => workflow.parentWorkflowInstanceId === undefined,
  );
  if (primary === undefined) return true;
  if (input.command === ConversationBuiltInCommand.Restart && isOperatorRetryEligible(primary))
    await input.restart(primary.workflowInstanceId);
  if (
    input.command === ConversationBuiltInCommand.Extend &&
    isGroupBudgetExtensionEligible(primary)
  )
    await input.extend(primary.workflowInstanceId);
  return true;
}
