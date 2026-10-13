import type { CommandContext } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../../activities/index.js';
import { type WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  ConversationBuiltInCommand,
  ConversationSurfaceCapability,
} from '../contracts/vocabulary.js';
import {
  isGroupBudgetExtensionEligible,
  isOperatorRetryEligible,
  selectChangesResumeTargets,
  selectOperatorRetryTarget,
} from '../domain/operator-retry-policy.js';

export const BuiltInConversationCommands = Object.values(ConversationBuiltInCommand);

export type SurfaceCapability = ConversationSurfaceCapability;

export type ConversationCommandSurface = { readonly capabilities: readonly SurfaceCapability[] };

export interface ConversationCommandInput {
  readonly body: string;
  readonly actorId: string;
  readonly capabilities: readonly SurfaceCapability[];
  /** Verified work-control authority. */
  readonly authorized: boolean;
  /** Independent-review authority must be supplied explicitly. */
  readonly reviewAuthorized?: boolean;
  /** Explicit continuation reenters the agent stage without a review decision. */
  readonly continuation?: boolean;
}

export type ConversationCommandResult =
  { readonly applied: true } | { readonly applied: false; readonly reason: string };

export function conversationCommand(body: string): string | null {
  const line = body.trim().split('\n', 1)[0]?.trim().toLowerCase() ?? '';
  return /^\/[a-z][a-z0-9-]*(?:\s.*)?$/.test(line) ? line.split(/\s/, 1)[0]! : null;
}

interface BuiltInConversationCommandInput {
  readonly command: string;
  readonly capabilities: readonly SurfaceCapability[];
  readonly reviewAuthorized: boolean;
  readonly workflows: readonly WorkflowInstanceView[];
  readonly context: CommandContext;
  readonly acceptSignal: (
    id: WorkflowInstanceId,
    outcome: typeof ActivityOutcomeKind.Done | typeof ActivityOutcomeKind.Rejected,
  ) => Promise<boolean>;
  readonly retry: (id: WorkflowInstanceId) => Promise<unknown>;
  readonly restart: (id: WorkflowInstanceId) => Promise<unknown>;
  readonly extend: (id: WorkflowInstanceId) => Promise<unknown>;
  readonly resumeChanges: (id: WorkflowInstanceId) => Promise<boolean>;
  readonly workAuthorized: boolean;
  readonly continuation: boolean;
}

// The command matrix is explicit so new built-ins cannot silently inherit power.
// eslint-disable-next-line complexity
export async function applyBuiltInConversationCommand(
  input: BuiltInConversationCommandInput,
): Promise<ConversationCommandResult> {
  const denied = (reason: string): ConversationCommandResult => ({ applied: false, reason });
  if (!BuiltInConversationCommands.includes(input.command as ConversationBuiltInCommand))
    return denied(
      'Unknown command. Use /changes with instructions to continue eligible blocked work, or /retry for a failed stage.',
    );
  if (
    !input.capabilities.includes(ConversationSurfaceCapability.Review) &&
    !input.capabilities.includes(ConversationSurfaceCapability.Operator)
  )
    return denied('This conversation surface does not permit work-control or review commands.');
  if (input.command === ConversationBuiltInCommand.Changes) {
    let applied = false;
    const continuationTargets = new Set(selectChangesResumeTargets(input.workflows));
    for (const workflow of input.workflows) {
      if (isOperatorRetryEligible(workflow) || isGroupBudgetExtensionEligible(workflow)) continue;
      const reviewed =
        !input.continuation && input.reviewAuthorized && workflow.waitingFor !== undefined
          ? await input.acceptSignal(workflow.workflowInstanceId, ActivityOutcomeKind.Rejected)
          : false;
      if (reviewed) applied = true;
      else if (input.workAuthorized && continuationTargets.has(workflow))
        applied = (await input.resumeChanges(workflow.workflowInstanceId)) || applied;
    }
    return applied ? { applied: true } : denied(changesDeniedReason(input.workAuthorized));
  }
  if (
    input.command === ConversationBuiltInCommand.Approved ||
    input.command === ConversationBuiltInCommand.Accepted
  ) {
    if (!input.reviewAuthorized)
      return denied(
        'Independent-review authority is required. An author cannot approve their own work; clarification uses /changes with instructions.',
      );
    let applied = false;
    for (const workflow of input.workflows)
      if (workflow.waitingFor !== undefined)
        applied =
          (await input.acceptSignal(workflow.workflowInstanceId, ActivityOutcomeKind.Done)) ||
          applied;
    return applied
      ? { applied: true }
      : denied(
          'No wait accepted this review decision. Check the configured authority and current revision.',
        );
  }
  if (input.command === ConversationBuiltInCommand.Retry) {
    const target = selectOperatorRetryTarget(input.workflows);
    if (target === undefined)
      return denied(
        'No retry-eligible failed stage. To continue eligible blocked agent work, use /changes followed by instructions.',
      );
    await input.retry(target.workflowInstanceId);
    return { applied: true };
  }
  const primary = input.workflows.find(
    (workflow) => workflow.parentWorkflowInstanceId === undefined,
  );
  if (primary === undefined) return denied('Work item has no primary workflow.');
  if (input.command === ConversationBuiltInCommand.Restart && isOperatorRetryEligible(primary)) {
    await input.restart(primary.workflowInstanceId);
    return { applied: true };
  }
  if (
    input.command === ConversationBuiltInCommand.Extend &&
    isGroupBudgetExtensionEligible(primary)
  ) {
    await input.extend(primary.workflowInstanceId);
    return { applied: true };
  }
  return denied(
    'Command is inapplicable: restart requires a failed stage; extend requires an exhausted watch-group budget.',
  );
}

function changesDeniedReason(workAuthorized: boolean): string {
  return workAuthorized
    ? 'No eligible blocked agent stage or authorized review wait. Use /retry for an eligible failed stage; watch gates require their configured authority.'
    : 'No review wait accepted this decision. Continuing blocked work requires verified repository write, maintain, or admin permission; watch gates retain their configured authority.';
}

export function continuationCommandRejection(
  input: ConversationCommandInput,
  command: string,
): string | null {
  if (!input.continuation) return null;
  if (command !== ConversationBuiltInCommand.Changes)
    return 'Continuation must use /changes followed by instructions.';
  if (!input.authorized) return 'Continuation requires verified work-control authority.';
  if (input.body.trim().slice(command.length).trim() === '')
    return 'Supply instructions after /changes to continue the blocked stage.';
  return null;
}
