import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/bootstrap/config/load-config.js';
import { initialiseWakeRoot } from '../../../src/bootstrap/initialise.js';
import { loadPromptTemplate, renderPromptTemplate } from '../../../src/execution/index.js';

describe('target initialise root', () => {
  it('creates the visible sandbox build asset and all target runtime roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);
    await expect(readFile(join(root, 'docker', 'Dockerfile'), 'utf8')).resolves.toContain('FROM');
    const config = await readFile(join(root, 'config.yaml'), 'utf8');
    expect(config).toContain('host:');
    expect(config).toContain('sandbox:');
    expect(config).toContain('containerName: wake-sandbox');
    expect(config).toContain('transcripts:\n  enabled: false\n  retentionMs: 86400000');
    expect(config).not.toContain('activationScheduler');
    expect(config).toContain('codex-luna: { kind: codex-cli, command: codex, model: gpt-5.6-luna');
    expect(config).toContain(
      'codex-terra: { kind: codex-cli, command: codex, model: gpt-5.6-terra',
    );
    expect(config).toContain('codex-sol: { kind: codex-cli, command: codex, model: gpt-5.6-sol');
    expect(await readdir(join(root, '.wake'))).toEqual(
      expect.arrayContaining([
        'events',
        'projections',
        'checkpoints',
        'locks',
        'transcripts',
        'logs',
      ]),
    );
  });

  it('derives sandbox.containerName from the wake-root directory name, sanitized', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    const root = join(base, 'My Project! (v2)');
    await initialiseWakeRoot(root);

    const config = await loadConfig(root);

    expect(config.host.sandbox.containerName).toBe('wake-sandbox-my-project-v2');
  });

  it('writes a config.yaml and config.workflows.yaml that together load and validate as-is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);

    const config = await loadConfig(root);

    expect(config).toMatchObject({
      execution: {
        defaultRunnerPool: 'standard',
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
      },
      orchestration: {
        workflowSelectors: expect.arrayContaining([
          { match: { tags: ['approval'] }, matchMode: 'all', workflow: 'approval' },
        ]),
        workflows: {
          default: {
            entry: 'refine',
            stages: {
              refine: { activity: 'agent', with: { template: 'refine' } },
              implement: { with: { template: 'implement' } },
            },
          },
          approval: {
            stages: {
              refine: {
                on: { done: { then: 'implement', await: { signal: 'approved', from: ['human'] } } },
              },
            },
          },
        },
      },
    });
    expect(Object.keys(config.orchestration.workflows.default!.stages)).toEqual([
      'refine',
      'implement',
    ]);
  });

  it('writes prompts/refine.md and prompts/implement.md as loadable, renderable templates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);

    for (const name of ['refine', 'implement'] as const) {
      const template = await loadPromptTemplate(root, name);
      expect(template.frontmatter.maxTurns).toBeGreaterThan(0);
      expect(template.frontmatter.allowedTools?.length).toBeGreaterThan(0);
      const rendered = renderPromptTemplate(template, {
        workItemId: 'work-01test0000000000000000',
        isStart: true,
        isResume: false,
      });
      expect(rendered).toContain('work-01test0000000000000000');
      expect(rendered).toMatch(/DONE, BLOCKED, NEEDS_CLARIFICATION, or FAILED/);
      if (name === 'implement') {
        expect(rendered).toContain('Include every pull request URL in the normal prose response.');
        expect(rendered).toContain('Then repeat each URL in this exact artifact fence');
        expect(rendered).toContain('```wake-artifacts');
        const resumed = renderPromptTemplate(template, {
          workItemId: 'work-01test0000000000000000',
          isStart: false,
          isResume: true,
        });
        expect(resumed).toContain('This is a resumed session.');
        expect(resumed).not.toContain('Your current working directory is a git checkout');
        expect(resumed).not.toContain('```wake-artifacts');
      }
    }
  });

  it('writes a SETUP.md that covers runners, integrations, and credential mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);

    const setup = await readFile(join(root, 'SETUP.md'), 'utf8');

    expect(setup).toContain('execution.agentRunners');
    expect(setup).toContain('runnerPools');
    expect(setup).toContain('integrations');
    expect(setup).toContain('provider: <provider-id>');
    expect(setup).toContain('host.sandbox.extraMounts');
    expect(setup).toContain('.credentials.json');
  });

  it('writes a Dockerfile that installs the runner CLIs named by execution.agentRunners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);

    const dockerfile = await readFile(join(root, 'docker', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('@anthropic-ai/claude-code');
    expect(dockerfile).toContain('@openai/codex');
    expect(dockerfile).toContain('gh');
    expect(dockerfile).toContain('cursor.com/install');
    expect(dockerfile).toContain('npm run build:docker');
    expect(dockerfile).toContain('dist/src/main.js');
    expect(dockerfile).toContain('/etc/codex/requirements.toml');
    expect(dockerfile).toContain('managed_dir = "/usr/local/lib/wake"');
    expect(dockerfile).toContain('node /usr/local/lib/wake/codex-stop-hook.js');
    expect(dockerfile).toContain('[features]');
    expect(dockerfile).toContain('hooks = true');
  });

  it('points the source-mode Dockerfile entrypoint at the supervised sandbox-entrypoint command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);

    const dockerfile = await readFile(join(root, 'docker', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('ENV WAKE_MAIN_JS=/app/dist/src/main.js');
    expect(dockerfile).toContain('sandbox-entrypoint');
    expect(dockerfile).not.toContain('sleep infinity');
    expect(dockerfile).not.toContain('WAKE_START_ENABLED" = "true"');
  });

  it('bootstraps only config-derived sandbox-home mount parents before dropping privileges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);

    for (const filename of ['Dockerfile', 'Dockerfile.packaged']) {
      const dockerfile = await readFile(join(root, 'docker', filename), 'utf8');
      expect(dockerfile).toContain('WAKE_HOME_INIT_DIRS');
      expect(dockerfile).toContain('mkdir -p \\"$directory\\"');
      expect(dockerfile).toContain('chown wake:wake \\"$directory\\"');
      expect(dockerfile).toContain('su wake');
      expect(dockerfile).toContain('USER root');
    }
  });

  it('repairs ownership of Wake runtime state before dropping sandbox privileges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);

    for (const filename of ['Dockerfile', 'Dockerfile.packaged']) {
      const dockerfile = await readFile(join(root, 'docker', filename), 'utf8');

      expect(dockerfile).toContain('mkdir -p /wake/.wake');
      expect(dockerfile).toContain('chown wake:wake /wake/.wake');
      expect(dockerfile).not.toContain('chown -R wake:wake /wake/.wake');
      expect(dockerfile).toContain('su wake');
    }
  });

  it('keeps repository sandbox images able to repair Wake runtime ownership', async () => {
    for (const filename of ['Dockerfile', 'Dockerfile.packaged']) {
      const dockerfile = await readFile(join(process.cwd(), 'docker', filename), 'utf8');

      expect(dockerfile).toContain('USER root');
      expect(dockerfile).toContain('mkdir -p /wake/.wake');
      expect(dockerfile).toContain('chown wake:wake /wake/.wake');
      expect(dockerfile).not.toContain('chown -R wake:wake /wake/.wake');
      expect(dockerfile).toContain('su wake');
    }
  });

  it('does not let a bind-mounted .wake ownership race fail the entrypoint under set -eu', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);

    for (const filename of ['Dockerfile', 'Dockerfile.packaged']) {
      const scaffolded = await readFile(join(root, 'docker', filename), 'utf8');
      const repository = await readFile(join(process.cwd(), 'docker', filename), 'utf8');

      expect(scaffolded).toContain('chown wake:wake /wake/.wake || true');
      expect(scaffolded).not.toContain('chown -R wake:wake /wake/.wake');
      expect(repository).toContain('chown wake:wake /wake/.wake || true');
      expect(repository).not.toContain('chown -R wake:wake /wake/.wake');
    }
  });
});
