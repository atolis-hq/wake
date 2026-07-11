import { createUiServer } from '../adapters/http/ui-server.js';
import type { createStateStore } from '../adapters/fs/state-store.js';
import type { WakeConfig } from '../domain/types.js';

type StateStore = ReturnType<typeof createStateStore>;

export async function runUiCommand(input: {
  args: string[];
  stateStore: StateStore;
  config: WakeConfig;
  readFlag: (name: string, args: string[]) => string | undefined;
  log?: (message: string) => void;
}): Promise<{ close(): Promise<void> }> {
  const log = input.log ?? console.log;
  const portFlag = input.readFlag('--port', input.args);
  const port = portFlag !== undefined ? Number(portFlag) : input.config.ui.port;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid --port: ${portFlag}`);
  }

  const host = input.readFlag('--host', input.args) ?? '127.0.0.1';
  const token = input.readFlag('--token', input.args) ?? input.config.ui.token ?? process.env.WAKE_UI_TOKEN;


  const server = createUiServer({
    stateStore: input.stateStore,
    config: input.config,
    ...(token === undefined ? {} : { token }),
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });

  log(`Wake UI listening on http://${host}:${port}`);

  return {
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}
