import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src-next/bootstrap/config/load-config.js';
import { initialiseWakeRoot } from '../../../src-next/bootstrap/initialise.js';
import { loadPromptTemplate, renderPromptTemplate } from '../../../src-next/execution/index.js';

describe('target initialise root', () => {
  it('creates the visible sandbox build asset and all target runtime roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);
    await expect(readFile(join(root, 'docker', 'Dockerfile'), 'utf8')).resolves.toContain('FROM');
    const config = await readFile(join(root, 'config.yaml'), 'utf8');
    expect(config).toContain('host:');
    expect(config).toContain('sandbox:');
    expect(config).toContain('containerName: wake-sandbox');
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
      });
      expect(rendered).toContain('work-01test0000000000000000');
      expect(rendered).toMatch(/DONE, BLOCKED, or FAILED/);
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
    expect(dockerfile).toContain('npm run build:next');
    expect(dockerfile).toContain('dist-next/src-next/main.js');
  });
});
