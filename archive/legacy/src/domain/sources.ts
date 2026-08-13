import type { WakeConfig } from './types.js';

/**
 * Names the configured ticket source. This is one decision with several
 * consumers that MUST agree: main.ts names the source it wires into the fan-in
 * and the sink router, while the UI builds `<provider>:issue:<repo>#<n>` URIs
 * to resolve tickets against the index those same events registered. If the
 * two ever disagreed, the UI would resolve against a provider nothing had
 * registered, miss, and report live work items as missing.
 *
 * It lives here, and not inline at each call site, because adding a third
 * source means changing this one function rather than finding every ternary —
 * source-pluggability is the point of the adapter seams, so the choice must
 * not be duplicated across them.
 */
export function configuredTicketSource(config: WakeConfig): string {
  return config.sources.github.enabled ? 'github' : 'fake-ticketing';
}
