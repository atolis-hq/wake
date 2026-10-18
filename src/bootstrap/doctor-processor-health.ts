import { z } from 'zod';
import {
  ApiHealthCheckKind,
  loadCredentials,
  type HealthResponse,
  type SurfacesConfig,
} from '../surfaces/index.js';

// Any status other than the healthy one is reported as a failure.
const healthyStatus: NonNullable<HealthResponse['checks']>[number]['status'] = 'ok';

const healthSchema = z.object({
  data: z.object({
    checks: z.array(
      z.object({
        name: z.string(),
        status: z.string(),
        kind: z.string().optional(),
        detail: z.string().optional(),
      }),
    ),
    adapters: z
      .array(
        z.object({
          adapter: z.string(),
          scope: z.string(),
          channel: z.string(),
          status: z.string(),
          detail: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

function unavailable(reason: string) {
  return { failures: [], notices: [`Processor health unavailable: ${reason}.`] };
}

/** Read live, volatile health without creating credentials or starting processors. */
export async function doctorProcessorHealth(wakeRoot: string, config: SurfacesConfig) {
  if (!config.api.enabled) return unavailable('the configured API is disabled');
  try {
    const host = ['0.0.0.0', '::'].includes(config.api.host) ? '127.0.0.1' : config.api.host;
    const base = new URL(`http://${host.includes(':') ? `[${host}]` : host}:${config.api.port}`);
    const signal = AbortSignal.timeout(2_000);
    let cookie = '';
    if (!config.web.auth.disabled) {
      let accessKey: string;
      try {
        accessKey = (await loadCredentials(wakeRoot)).accessKey;
      } catch {
        return unavailable('no readable API credentials');
      }
      const login = await fetch(new URL('/api/v1/auth/login', base), {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessKey }),
      });
      if (!login.ok) return unavailable(`API authentication failed (HTTP ${login.status})`);
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
    if (!response.ok) return unavailable(`health request failed (HTTP ${response.status})`);
    const parsed = healthSchema.safeParse(await response.json());
    if (!parsed.success) return unavailable('the API returned an unrecognised health response');
    const checks = parsed.data.data.checks.filter(
      ({ kind }) => kind === ApiHealthCheckKind.Processor,
    );
    if (checks.length === 0) return unavailable('the API reported no processors');
    // Only degraded adapters are reported; 'unknown' means never exercised.
    const adapterFailures = (parsed.data.data.adapters ?? [])
      .filter(({ status }) => status === 'degraded')
      .map(
        ({ adapter, scope, channel, detail }) =>
          `Adapter ${adapter} ${scope} (${channel}): ${detail ?? 'degraded'}`,
      );
    return {
      failures: [
        ...checks
          .filter(({ status }) => status !== healthyStatus)
          .map(({ name, detail }) => `Processor ${name}: ${detail ?? 'degraded'}`),
        ...adapterFailures,
      ],
      notices: checks
        .filter(({ status }) => status === healthyStatus)
        .map(({ name, detail }) => `Processor ${name}: ${detail ?? 'ok'}`),
    };
  } catch {
    return unavailable('the configured API is unreachable');
  }
}
