import type { CommandContext } from '@atolis-hq/eventing';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DelegationConflictError,
  delegationSubmissionSchema,
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
        'Submit child work with optional queued named-output prerequisites under this workflow delegation policy. Use expectedPlanRevision from inspection; useAsBase selects only a same-repository upstream change. End the current activity normally after submission; Wake waits and resumes it with joined results or terminal failure facts. Inspect failureReason and blockers before submitting replacement assignments in a new cohort; existing receipts remain immutable.',
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
