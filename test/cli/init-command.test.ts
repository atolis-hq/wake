import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { runInitCommand } from '../../src/cli/init-command.js';

describe('init command', () => {
  const promptFiles = [
    'refine.start.md',
    'refine.resume.md',
    'implement.start.md',
    'implement.resume.md',
  ] as const;
  const dockerAssets = ['Dockerfile', 'setup.sh', 'log-command.sh'] as const;
  const launcherScripts = ['wake.sh', 'wake.ps1'] as const;
  const runtimeDirectories = [
    'events',
    'state',
    'runs',
    'workspaces',
    'repos',
    'sources',
    'locks',
    'logs',
  ] as const;

  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'wake-init-command-'));
  });

  it('scaffolds a wake home with config, prompts, docker assets, and runtime directories', async () => {
    const targetRoot = await mkdtemp(join(tempRoot, 'cwd-'));
    const homeDir = 'wake-home';
    const repoRoot = process.cwd();

    const result = await runInitCommand({
      cwd: targetRoot,
      args: [homeDir],
      repoRoot,
    });

    expect(result.wakeRoot).toBe(join(targetRoot, homeDir));

    const config = await readFile(join(result.wakeRoot, 'config.json'), 'utf8');
    const dockerfile = await readFile(join(result.wakeRoot, 'docker', 'Dockerfile'), 'utf8');
    const setupScript = await readFile(join(result.wakeRoot, 'docker', 'setup.sh'), 'utf8');
    const logScript = await readFile(join(result.wakeRoot, 'docker', 'log-command.sh'), 'utf8');
    const shellLauncher = await readFile(join(result.wakeRoot, 'wake.sh'), 'utf8');
    const powerShellLauncher = await readFile(join(result.wakeRoot, 'wake.ps1'), 'utf8');

    expect(config).toContain('"sandbox"');
    expect(config).toContain(`"repoRoot": "${repoRoot.replaceAll('\\', '\\\\')}"`);
    expect(dockerfile).toContain('ENTRYPOINT ["sleep", "infinity"]');
    expect(setupScript).toContain('Wake sandbox setup starting.');
    expect(setupScript).toContain('gh auth login');
    expect(setupScript).toContain('prompt_yes_no "Configure GitHub auth?"');
    expect(setupScript).not.toContain('gh auth status >/dev/null 2>&1');
    expect(setupScript).not.toContain('docker exec');
    expect(setupScript).not.toContain('\r\n');
    expect(setupScript).toContain('claude auth login --claudeai');
    expect(setupScript).toContain('prompt_yes_no "Configure Claude auth?"');
    expect(setupScript).not.toContain('claude auth status >/dev/null 2>&1');
    expect(setupScript).toContain('codex login');
    expect(setupScript).toContain('prompt_yes_no "Configure Codex auth?"');
    expect(setupScript).toContain('ssh-keygen -t ed25519');
    expect(dockerfile).toContain('@anthropic-ai/claude-code');
    expect(dockerfile).toContain('@openai/codex');
    expect(logScript).toContain('emit_check "claude-auth-status" claude auth status');
    expect(logScript).toContain('emit_check "codex-auth-status" codex login status');
    expect(shellLauncher).toContain(repoRoot.replaceAll('\\', '/'));
    expect(shellLauncher).toContain('case "${1:-}" in');
    expect(shellLauncher).toContain('MSYS_NO_PATHCONV=1');
    expect(shellLauncher).toContain("MSYS2_ARG_CONV_EXCL='*'");
    expect(shellLauncher).toContain('sandbox exec -- node "$CONTAINER_MAIN"');
    expect(shellLauncher).toContain('rewritten_args+=("--wake-root" "/wake")');
    expect(powerShellLauncher).toContain(repoRoot);
    expect(powerShellLauncher).toContain("switch ($command)");
    expect(powerShellLauncher).toContain('sandbox exec -- node $containerMain');
    expect(powerShellLauncher).toContain("$rewrittenArgs.Add('--wake-root')");
    expect(powerShellLauncher).toContain("$rewrittenArgs.Add('/wake')");

    for (const promptFile of promptFiles) {
      const prompt = await readFile(join(result.wakeRoot, 'prompts', promptFile), 'utf8');
      expect(prompt.length).toBeGreaterThan(0);
    }

    expect(
      await readFile(join(result.wakeRoot, 'prompts', 'refine.start.md'), 'utf8'),
    ).toContain('stage: refine');

    for (const dockerAsset of dockerAssets) {
      expect((await stat(join(result.wakeRoot, 'docker', dockerAsset))).isFile()).toBe(true);
    }

    for (const launcherScript of launcherScripts) {
      expect((await stat(join(result.wakeRoot, launcherScript))).isFile()).toBe(true);
    }

    for (const runtimeDirectory of runtimeDirectories) {
      expect((await stat(join(result.wakeRoot, runtimeDirectory))).isDirectory()).toBe(true);
    }
  });

  it('rejects init when the target directory is not empty', async () => {
    const targetRoot = await mkdtemp(join(tempRoot, 'non-empty-'));
    await mkdir(join(targetRoot, 'occupied'));
    await writeFile(join(targetRoot, 'occupied', 'seed.txt'), 'seed\n', 'utf8');

    await expect(
      runInitCommand({
        cwd: targetRoot,
        args: [],
        repoRoot: process.cwd(),
      }),
    ).rejects.toThrow(/empty directory/i);
  });
});
