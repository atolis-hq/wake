import type { CommandContext } from '@atolis-hq/eventing';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
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
        'Submit independent child work under this workflow delegation policy. End the current activity normally after submission; Wake waits and resumes it with joined results.',
      inputSchema: delegationSubmissionSchema,
    },
    async (command) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            await input.orchestration.submitDelegation(
              await input.caller(),
              command,
              input.commandContext(),
            ),
          ),
        },
      ],
    }),
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
