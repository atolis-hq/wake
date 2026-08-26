import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import wakeLogo from '../../../../../assets/wake-logo.svg';
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
  const [authenticated, setAuthenticated] = useState<boolean | undefined>();
  useEffect(() => {
    const grant = new URLSearchParams(globalThis.location.search).get('grant');
    const authenticate = async () => {
      if (grant !== null) {
        const redeemed = await client.auth.redeem(grant);
        globalThis.history.replaceState(
          {},
          '',
          `${globalThis.location.pathname}${globalThis.location.hash}`,
        );
        if (redeemed) return setAuthenticated(true);
      }
      return client.auth
        .session()
        .then(setAuthenticated)
        .catch(() => setAuthenticated(false));
    };
    void authenticate();
  }, [client]);
  if (authenticated === undefined) return null;
  if (!authenticated)
    return <Login client={client} onAuthenticated={() => setAuthenticated(true)} />;
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientContext.Provider value={client}>
        <AppRoutes />
      </ApiClientContext.Provider>
    </QueryClientProvider>
  );
}

function Login({
  client,
  onAuthenticated,
}: {
  readonly client: WakeApiClient;
  readonly onAuthenticated: () => void;
}) {
  const [accessKey, setAccessKey] = useState('');
  const [failed, setFailed] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await client.auth.redeem(accessKey)) onAuthenticated();
    else setFailed(true);
  }
  return (
    <main className="wake-login">
      <div className="wake-login-panel">
        <section className="wake-login-brand">
          <img className="wake-login-logo" src={wakeLogo} alt="Wake logo" />
        </section>
        <section className="wake-login-card">
          <h1>Login</h1>
          <p>Enter a temporary login code, or scan the code from your operator terminal.</p>
          <form onSubmit={submit}>
            <label htmlFor="access-key">Temporary login code</label>
            <input
              id="access-key"
              type="password"
              value={accessKey}
              onChange={(event) => setAccessKey(event.target.value)}
              autoFocus
              required
            />
            <button className="wake-login-submit" type="submit">
              Sign in
            </button>
            {failed && <p role="alert">Unable to sign in.</p>}
          </form>
        </section>
      </div>
    </main>
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
