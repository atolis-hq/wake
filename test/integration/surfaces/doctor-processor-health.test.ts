import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { doctorProcessorHealth } from '../../../src/bootstrap/doctor-processor-health.js';
import { surfacesConfigSchema } from '../../../src/surfaces/index.js';

it('reads authenticated live health without changing auth or runtime state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-doctor-health-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === '/api/v1/auth/login') {
      let body = '';
      request.on('data', (data) => {
        body += data;
      });
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({ accessKey: 'existing-key' });
        response.setHeader('set-cookie', 'session=test; HttpOnly; Path=/');
        response.end('{}');
      });
      return;
    }
    expect(request.headers.cookie).toBe('session=test');
    response.end(
      JSON.stringify({
        data: {
          checks: [
            { name: 'journal', status: 'ok' },
            {
              name: 'projection:delivery',
              kind: 'event-processor',
              status: 'degraded',
              detail: 'event poison at global position 4',
            },
            {
              name: 'activation-scheduler',
              kind: 'event-processor',
              status: 'ok',
              detail: 'healthy',
            },
          ],
          adapters: [
            {
              adapter: 'github',
              scope: 'org/repo',
              channel: 'poll',
              status: 'degraded',
              detail: 'stalled: no successful poll for 900s (threshold 180s)',
            },
            { adapter: 'github', scope: 'org/repo', channel: 'deliver', status: 'unknown' },
          ],
        },
      }),
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing port');
    const config = surfacesConfigSchema.parse({ api: { enabled: true, port: address.port } });
    const unavailable = await doctorProcessorHealth(home, config);
    expect(unavailable.notices).toContainEqual(expect.stringContaining('unavailable'));
    expect(await readdir(home)).toEqual([]);
    await mkdir(join(home, '.wake/auth'), { recursive: true });
    const credentials = JSON.stringify({
      accessKey: 'existing-key',
      sessionPassword: Buffer.alloc(32).toString('base64url'),
      createdAt: '2026-10-18T00:00:00Z',
    });
    await writeFile(join(home, '.wake/auth/credentials.json'), credentials);
    expect(await doctorProcessorHealth(home, config)).toEqual({
      failures: [
        'Processor projection:delivery: event poison at global position 4',
        'Adapter github org/repo (poll): stalled: no successful poll for 900s (threshold 180s)',
      ],
      notices: ['Processor activation-scheduler: healthy'],
    });
    expect(requests).toEqual(['/api/v1/auth/login', '/api/v1/system/health']);
    expect(await readdir(join(home, '.wake'))).toEqual(['auth']);
    expect(await readdir(join(home, '.wake/auth'))).toEqual(['credentials.json']);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(home, { recursive: true, force: true });
  }
});
