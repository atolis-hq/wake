import { describe, expect, it, vi } from 'vitest';
import { runSandboxEntrypointCommand } from '../../src/cli/sandbox-entrypoint-command.js';

function neverExits() {
  return new Promise<number>(() => {});
}

describe('runSandboxEntrypointCommand', () => {
  it('starts the UI process when WAKE_UI_ENABLED=true', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: { WAKE_UI_ENABLED: 'true', WAKE_UI_PORT: '4317' },
      spawnDetached,
      waitForExit: vi.fn(neverExits),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['ui', '--wake-root', '/wake', '--host', '0.0.0.0', '--port', '4317']),
    );
  });

  it('does not start the UI process when WAKE_UI_ENABLED is unset', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: {},
      spawnDetached,
      waitForExit: vi.fn(neverExits),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).not.toHaveBeenCalledWith('node', expect.arrayContaining(['ui']));
  });

  it('starts the resident wake start loop when WAKE_START_ENABLED=true', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 456 }));

    await runSandboxEntrypointCommand({
      env: { WAKE_START_ENABLED: 'true' },
      spawnDetached,
      waitForExit: vi.fn(neverExits),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['start', '--wake-root', '/wake']),
    );
  });

  it('defaults WAKE_UI_PORT to 4317 when unset', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: { WAKE_UI_ENABLED: 'true' },
      spawnDetached,
      waitForExit: vi.fn(neverExits),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).toHaveBeenCalledWith('node', expect.arrayContaining(['--port', '4317']));
  });

  it('passes --token when WAKE_UI_TOKEN is set', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: { WAKE_UI_ENABLED: 'true', WAKE_UI_TOKEN: 'secret-token' },
      spawnDetached,
      waitForExit: vi.fn(neverExits),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['--token', 'secret-token']),
    );
  });

  it('does not pass --token when WAKE_UI_TOKEN is unset', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: { WAKE_UI_ENABLED: 'true' },
      spawnDetached,
      waitForExit: vi.fn(neverExits),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).not.toHaveBeenCalledWith('node', expect.arrayContaining(['--token']));
  });

  it('starts an ngrok tunnel and configures the authtoken when WAKE_UI_TUNNEL_ENABLED=true and NGROK_AUTHTOKEN is set', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: {
        WAKE_UI_ENABLED: 'true',
        WAKE_UI_PORT: '4317',
        WAKE_UI_TUNNEL_ENABLED: 'true',
        NGROK_AUTHTOKEN: 'ngrok-token',
      },
      spawnDetached,
      waitForExit: vi.fn(neverExits),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).toHaveBeenCalledWith('ngrok', ['config', 'add-authtoken', 'ngrok-token']);
    expect(spawnDetached).toHaveBeenCalledWith('ngrok', ['http', '127.0.0.1:4317', '--log=stdout']);
  });

  it('does not start ngrok when WAKE_UI_TUNNEL_ENABLED is unset', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: { WAKE_UI_ENABLED: 'true' },
      spawnDetached,
      waitForExit: vi.fn(neverExits),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).not.toHaveBeenCalledWith('ngrok', expect.anything());
  });

  it('writes the discovered ngrok public url to the control-plane-ui-url file', async () => {
    const writeFile = vi.fn(async () => {});
    const log = vi.fn();

    await runSandboxEntrypointCommand({
      env: { WAKE_UI_ENABLED: 'true', WAKE_UI_TUNNEL_ENABLED: 'true' },
      spawnDetached: vi.fn(() => ({ pid: 123 })),
      waitForExit: vi.fn(neverExits),
      writeFile,
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => 'https://example.ngrok.io'),
      log,
    });

    // discovery runs in the background (fire-and-forget), so flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeFile).toHaveBeenCalledWith(
      '/wake/control-plane-ui-url',
      expect.stringContaining('https://example.ngrok.io'),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('https://example.ngrok.io'));
  });

  it('logs a fallback message and does not write the file when the ngrok url is not discovered', async () => {
    const writeFile = vi.fn(async () => {});
    const log = vi.fn();

    await runSandboxEntrypointCommand({
      env: { WAKE_UI_ENABLED: 'true', WAKE_UI_TUNNEL_ENABLED: 'true' },
      spawnDetached: vi.fn(() => ({ pid: 123 })),
      waitForExit: vi.fn(neverExits),
      writeFile,
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('was not discovered'));
  });

  it('does not start the wake start loop when WAKE_START_ENABLED is unset', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: {},
      spawnDetached,
      waitForExit: vi.fn(neverExits),
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).not.toHaveBeenCalledWith('node', expect.arrayContaining(['start']));
  });

  it('restarts the wake start loop after the process exits, waiting the configured delay', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 456 }));
    const sleep = vi.fn(async () => {});
    let resolveExit: ((code: number) => void) | undefined;
    const waitForExit = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            resolveExit = resolve;
          }),
      )
      .mockImplementation(neverExits);

    await runSandboxEntrypointCommand({
      env: { WAKE_START_ENABLED: 'true', WAKE_START_RESTART_DELAY_SECONDS: '5' },
      spawnDetached,
      waitForExit,
      writeFile: vi.fn(async () => {}),
      sleep,
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).toHaveBeenCalledTimes(1);

    resolveExit?.(1);
    // Flush the microtask queue so the loop's continuation runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sleep).toHaveBeenCalledWith(5000);
    expect(spawnDetached).toHaveBeenCalledTimes(2);
  });
});
