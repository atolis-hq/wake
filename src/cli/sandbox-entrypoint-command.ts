const MAIN_JS_PATH = '/app/dist/src/main.js';
const CONTROL_PLANE_UI_URL_FILE = '/wake/.wake/control-plane-ui-url';
const DEFAULT_UI_PORT = '4317';
const DEFAULT_START_RESTART_DELAY_SECONDS = 10;

export interface SandboxEntrypointDeps {
  env: NodeJS.ProcessEnv;
  spawnDetached: (
    command: string,
    args: string[],
    options?: { logFile?: string },
  ) => { pid: number };
  waitForExit: (pid: number) => Promise<number>;
  writeFile: (path: string, content: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  discoverNgrokUrl: () => Promise<string | undefined>;
  log: (message: string) => void;
  ensureDir: (path: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
}

async function discoverAndWriteNgrokUrl(deps: SandboxEntrypointDeps): Promise<void> {
  await deps.removeFile(CONTROL_PLANE_UI_URL_FILE);

  const publicUrl = await deps.discoverNgrokUrl();

  if (publicUrl !== undefined) {
    await deps.writeFile(CONTROL_PLANE_UI_URL_FILE, `${publicUrl}\n`);
    deps.log(`wake ui: ngrok tunnel available at ${publicUrl}`);
    return;
  }

  deps.log(
    'wake ui: ngrok tunnel started but public URL was not discovered; see /wake/.wake/logs/ngrok.log',
  );
}

async function superviseWakeStart(
  deps: SandboxEntrypointDeps,
  restartDelaySeconds: number,
): Promise<void> {
  for (;;) {
    deps.log('wake start: starting resident loop');
    const { pid } = deps.spawnDetached('node', [MAIN_JS_PATH, 'start', '--wake-root', '/wake'], {
      logFile: '/wake/.wake/logs/start.log',
    });
    await deps.writeFile('/wake/.wake/logs/start.pid', String(pid));
    const exitCode = await deps.waitForExit(pid);
    deps.log(
      `wake start: resident loop exited with status ${exitCode}; restarting in ${restartDelaySeconds}s`,
    );
    await deps.sleep(restartDelaySeconds * 1000);
  }
}

export async function runSandboxEntrypointCommand(deps: SandboxEntrypointDeps): Promise<void> {
  const { env } = deps;

  await deps.ensureDir('/wake/.wake/logs');

  if (env.WAKE_UI_ENABLED === 'true') {
    const port = env.WAKE_UI_PORT ?? DEFAULT_UI_PORT;
    deps.log(`wake ui: starting on 0.0.0.0:${port}`);

    const uiArgs = [
      MAIN_JS_PATH,
      'ui',
      '--wake-root',
      '/wake',
      '--host',
      '0.0.0.0',
      '--port',
      port,
    ];
    if (env.WAKE_UI_TOKEN) {
      uiArgs.push('--token', env.WAKE_UI_TOKEN);
    }
    deps.spawnDetached('node', uiArgs, { logFile: '/wake/.wake/logs/ui.log' });

    if (env.WAKE_UI_TUNNEL_ENABLED === 'true') {
      if (env.NGROK_AUTHTOKEN) {
        const { pid } = deps.spawnDetached(
          'ngrok',
          ['config', 'add-authtoken', env.NGROK_AUTHTOKEN],
          { logFile: '/wake/.wake/logs/ngrok.log' },
        );
        await deps.waitForExit(pid);
      }

      deps.log(`wake ui: starting ngrok tunnel for 127.0.0.1:${port}`);
      deps.spawnDetached('ngrok', ['http', `127.0.0.1:${port}`, '--log=stdout'], {
        logFile: '/wake/.wake/logs/ngrok.log',
      });
      void discoverAndWriteNgrokUrl(deps);
    }
  }

  if (env.WAKE_START_ENABLED === 'true') {
    const restartDelaySeconds = Number(
      env.WAKE_START_RESTART_DELAY_SECONDS ?? DEFAULT_START_RESTART_DELAY_SECONDS,
    );
    void superviseWakeStart(deps, restartDelaySeconds);
  }
}
