import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const BrowserRouteOutcome = defineClosedVocabulary({
  Spa: 'spa',
  NotFound: 'not-found',
} as const);

export type BrowserRouteOutcome = ValueOf<typeof BrowserRouteOutcome>;

/** Browser history fallback must never mask a missing API or static asset. */
export function routeBrowserRequest(method: string, pathname: string): BrowserRouteOutcome {
  if (method !== 'GET' && method !== 'HEAD') return BrowserRouteOutcome.NotFound;
  if (pathname.startsWith('/api/') || /\/[^/]+\.[^/]+$/.test(pathname))
    return BrowserRouteOutcome.NotFound;
  return BrowserRouteOutcome.Spa;
}
