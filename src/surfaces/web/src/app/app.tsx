import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { WakeApiClient } from '../api/client.js';
import { ApiClientContext } from '../api/context.js';
import { AppShell } from '../components/app-shell.js';
import { Board } from '../features/board/board.js';
import { ConfigurationPage } from '../features/configuration/configuration.js';
import { EventsPage } from '../features/events/events.js';
import { HealthPage } from '../features/health/health.js';
import { ObservabilityPage } from '../features/observability/observability.js';
import { RunDetail, RunsList } from '../features/runs/runs.js';
import { WorkDetail, WorkList } from '../features/work/work.js';

export function App({ client = new WakeApiClient() }: { readonly client?: WakeApiClient }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            refetchIntervalInBackground: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientContext.Provider value={client}>
        <AppRoutes />
      </ApiClientContext.Provider>
    </QueryClientProvider>
  );
}

function AppRoutes() {
  const location = useLocation();
  const background = (location.state as { readonly background?: typeof location } | null)
    ?.background;
  const desktop = useMediaQuery('(min-width: 48rem)');
  const modal = background !== undefined && desktop && !isHardReload();
  return (
    <AppShell>
      <Routes location={modal ? background : location}>
        <Route path="/" element={<Navigate to="/board" replace />} />
        <Route path="/board" element={<Board />} />
        <Route path="/work" element={<WorkList />} />
        <Route path="/work/:workItemKey" element={<WorkDetail />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/runs" element={<RunsList />} />
        <Route path="/runs/:runId" element={<RunDetail />} />
        <Route path="/observability" element={<ObservabilityPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/configuration" element={<ConfigurationPage />} />
        <Route path="*" element={<Navigate to="/board" replace />} />
      </Routes>
      {modal && (
        <Routes>
          <Route path="/work/:workItemKey" element={<WorkDetail modal />} />
        </Routes>
      )}
    </AppShell>
  );
}

function isHardReload(): boolean {
  const entry = globalThis.performance?.getEntriesByType?.('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  return entry?.type === 'reload';
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const media = globalThis.matchMedia?.(query);
    if (media === undefined) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}
