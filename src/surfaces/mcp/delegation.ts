import type { CommandContext } from '@atolis-hq/eventing';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DelegationAttentionError,
  DelegationConflictError,
  DeliveryRejectionError,
  delegationAttentionReplySchema,
  delegationSubmissionSchema,
  deliveryCandidateCommandSchema,
  deliveryMaintenanceCommandSchema,
  deliveryQaCommandSchema,
  deliverySelectionCommandSchema,
  type DelegationCaller,
  type OrchestrationService,
} from '../../orchestration/index.js';

/** The bound caller is never accepted as a tool argument. */
export function registerDelegationTools(
  server: McpServer,
  input: {
    readonly orchestration: OrchestrationService;
    readonly caller: () => Promise<DelegationCaller>;
    readonly commandContext: () => CommandContext;
  },
) {
  server.registerTool(
    'wake_delegation_submit',
    {
      description:
        'Submit child work with optional queued named-output prerequisites under this workflow delegation policy. An assignment objective is a one-line summary that titles the child work item; the child reads its objective and criteria as the opening message of its conversation, so put detail in criteria or a granted artifact. Use expectedPlanRevision from inspection; useAsBase selects only a same-repository upstream change. End the current activity normally after submission; Wake waits and resumes it with joined results or terminal failure facts. Inspect failureReason and blockers before submitting replacement assignments in a new cohort; existing receipts remain immutable.',
      inputSchema: delegationSubmissionSchema,
    },
    async (command) => {
      try {
        const reservation = await input.orchestration.submitDelegation(
          await input.caller(),
          command,
          input.commandContext(),
        );
        return { content: [{ type: 'text', text: JSON.stringify(reservation) }] };
      } catch (error) {
        if (!(error instanceof DelegationConflictError)) throw error;
        return {
          isError: true,
          content: [
            { type: 'text', text: JSON.stringify({ code: error.code, message: error.message }) },
          ],
        };
      }
    },
  );
  server.registerTool(
    'wake_delegation_respond',
    {
      description:
        'Answer one assignment-context blocker from the attention request returned by wake_delegation_inspect. Name the child, blocker and expectedRevision, then answer with a free-text `message` (posted to the conversation of the child, which it reads when it resumes), with accepted artifact `references` it may read, or both; a reply needs at least one. Only a child blocked for assignment context can be resumed; failures need follow-up work in a new cohort and human review, consent or approval gates cannot be answered here. End the activity normally afterwards; unresolved reasons stay tracked and the cohort wait resumes.',
      inputSchema: delegationAttentionReplySchema,
    },
    async (reply) => {
      try {
        const attention = await input.orchestration.respondToDelegationAttention(
          await input.caller(),
          reply,
          input.commandContext(),
        );
        return { content: [{ type: 'text', text: JSON.stringify(attention) }] };
      } catch (error) {
        if (!(error instanceof DelegationAttentionError)) throw error;
        return {
          isError: true,
          content: [
            { type: 'text', text: JSON.stringify({ code: error.code, message: error.message }) },
          ],
        };
      }
    },
  );
  // Rejections carry a typed code so the agent can correct the request instead of retrying.
  const guarded = async (run: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await run()) }] };
    } catch (error) {
      if (!(error instanceof DeliveryRejectionError)) throw error;
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ code: error.code, message: error.message }),
          },
        ],
      };
    }
  };
  server.registerTool(
    'wake_delivery_select',
    {
      description:
        'Record the complete current delivery selection: for every original required output, the qualifying child output that covers it, or an authorized replacement that names the output it replaces. Pass expectedRevision from wake_delegation_inspect (delivery.selectionRevision). Omitting a required output, selecting an unqualified output or replacing a stale choice is rejected.',
      inputSchema: deliverySelectionCommandSchema,
    },
    async (command) =>
      guarded(async () =>
        input.orchestration.selectDelivery(await input.caller(), command, input.commandContext()),
      ),
  );
  server.registerTool(
    'wake_delivery_candidate',
    {
      description:
        'Record the exact combined candidate for the current selection: one repository entry per repository with selected changes, using the selected output tip (a single change or intentional stack) or an assembled commit pushed under refs/wake/delivery/<root>/<candidateId>/. Wake verifies the commit is fetchable from the repository before QA can rely on it.',
      inputSchema: deliveryCandidateCommandSchema,
    },
    async (command) =>
      guarded(async () =>
        input.orchestration.recordDeliveryCandidate(
          await input.caller(),
          command,
          input.commandContext(),
        ),
      ),
  );
  server.registerTool(
    'wake_delivery_qa',
    {
      description:
        'Record the QA verdict for a recorded candidate. Name the exact repository revisions checked; they must equal the candidate set. Use verdict blocked when the environment or a source is unavailable, fail with findings when defects remain, and pass only after the configured recipe ran.',
      inputSchema: deliveryQaCommandSchema,
    },
    async (command) =>
      guarded(async () =>
        input.orchestration.recordDeliveryQa(await input.caller(), command, input.commandContext()),
      ),
  );
  server.registerTool(
    'wake_delivery_maintenance',
    {
      description:
        'Record what you actually did to one selected pull request during integration maintenance (retarget, rebase or resolve) in the branch workspace Wake leased for it. Name the head you started from (expectedRevision) and the resulting pushed head and pull request base. Wake verifies the provider head and records a new subject: earlier reviews, checks and QA stay historical, and fresh review, checks and a new candidate with QA are required before the next merge.',
      inputSchema: deliveryMaintenanceCommandSchema,
    },
    async (command) =>
      guarded(async () =>
        input.orchestration.recordDeliveryMaintenance(
          await input.caller(),
          command,
          input.commandContext(),
        ),
      ),
  );
  server.registerTool(
    'wake_delegation_inspect',
    {
      description:
        'Inspect this delivery tree, child workflows, results and blockers, and the Repository Resource IDs an explicit repository selection may name.',
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            await input.orchestration.inspectDelegation(
              await input.caller(),
              input.commandContext(),
            ),
          ),
        },
      ],
    }),
  );
}
