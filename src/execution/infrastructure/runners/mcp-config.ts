import type { RunnerRequest } from '../../contracts/runner.js';

/** The `{ mcpServers: { name: { command, args?, env? } } }` shape Claude and Copilot accept. */
export function mcpServersConfig(request: RunnerRequest) {
  return {
    mcpServers: Object.fromEntries(
      (request.mcpServers ?? []).map((server) => [
        server.name,
        {
          command: server.command,
          ...(server.args === undefined ? {} : { args: server.args }),
          ...(server.env === undefined ? {} : { env: server.env }),
        },
      ]),
    ),
  };
}
