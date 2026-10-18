import { z } from 'zod';
import { loadCredentials, type SurfacesConfig } from '../surfaces/index.js';

const healthSchema = z.object({
  data: z.object({
    checks: z.array(
      z.object({
        name: z.string(),
        status: z.enum(['ok', 'degraded']),
        detail: z.string().optional(),
      }),
    ),
  }),
});

/** Read live, volatile health without creating credentials or starting processors. */
export async function doctorProcessorHealth(wakeRoot: string, config: SurfacesConfig) {
  const unavailable = {
    failures: [],
    notices: ['Processor health unavailable: configured API is disabled or unreachable.'],
  };
  if (!config.api.enabled) return unavailable;
  try {
    const host = ['0.0.0.0', '::'].includes(config.api.host) ? '127.0.0.1' : config.api.host;
    const base = new URL(`http://${host.includes(':') ? `[${host}]` : host}:${config.api.port}`);
    const signal = AbortSignal.timeout(2_000);
    let cookie = '';
    if (!config.web.auth.disabled) {
      const credentials = await loadCredentials(wakeRoot);
      const login = await fetch(new URL('/api/v1/auth/login', base), {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessKey: credentials.accessKey }),
      });
      if (!login.ok) return unavailable;
      cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
    }
    const response = await fetch(new URL('/api/v1/system/health', base), {
      redirect: 'error',
      signal,
      headers: { cookie },
    });
    if (!response.ok) return unavailable;
    const health = healthSchema.parse(await response.json());
    const checks = health.data.checks.filter(
      ({ name }) => name.includes(':') || name === 'activation-scheduler',
    );
    if (checks.length === 0) return unavailable;
    return {
      failures: checks
        .filter(({ status }) => status === 'degraded')
        .map(({ name, detail }) => `Processor ${name}: ${detail ?? 'degraded'}`),
      notices: checks
        .filter(({ status }) => status === 'ok')
        .map(({ name, detail }) => `Processor ${name}: ${detail ?? 'ok'}`),
    };
  } catch {
    return unavailable;
  }
}
