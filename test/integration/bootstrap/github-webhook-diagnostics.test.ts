import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCompositionRoot, createSurfaceApplications } from '../../../src/bootstrap/index.js';

it('composes persisted webhook failures into Doctor notices and adapter health without reprovisioning', async () => {
  const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-webhook-doctor-'));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/hooks') && init?.method === 'POST')
      return new Response(JSON.stringify({ message: 'secret-bearing upstream text' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    return new Response(JSON.stringify({ login: 'operator' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    await writeFile(
      join(wakeRoot, 'config.yaml'),
      `schemaVersion: 1
execution:
  agentRunners: { fake: { kind: fake } }
  runnerPools: { standard: [fake] }
  defaultRunnerPool: standard
integrations:
  github:
    enabled: true
    token: ghp_configured_token
    repositories: [{ owner: atolis-hq, repo: wake }]
    webhooks: { enabled: true }
surfaces:
  web: { publicUrl: 'https://wake.example' }
`,
    );
    const root = await createCompositionRoot(wakeRoot);
    await root.providers[0]!.webhook!.provision();
    const [message] = await root.providers[0]!.webhook!.diagnostics!();
    expect(message).toContain('create webhook failed: HTTP 404');
    expect(root.providers[0]!.health!()).toContainEqual(
      expect.objectContaining({
        channel: 'webhook',
        status: 'degraded',
        detail: expect.stringContaining(message!),
      }),
    );
    const status = await (await createSurfaceApplications(root)).api.system!.health();
    expect(status.data.adapters).toContainEqual(
      expect.objectContaining({
        channel: 'webhook',
        status: 'degraded',
        detail: expect.stringContaining(message!),
      }),
    );
    const restarted = await createCompositionRoot(wakeRoot);
    const report = (await (
      await createSurfaceApplications(restarted)
    ).cli.operational!.doctor([])) as { notices: string[] };
    expect(report.notices).toContain(message);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/hooks'))).toHaveLength(1);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(message + '\n');
    expect(JSON.stringify(report)).not.toMatch(/ghp_configured_token|secret-bearing/);
  } finally {
    vi.unstubAllGlobals();
    stderr.mockRestore();
    await rm(wakeRoot, { recursive: true, force: true });
  }
});
