import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router';
import wakeLogo from '../../../../../assets/wake-logo.svg';
import { useApiClient } from '../api/context.js';
import { queryKeys } from '../api/query-keys.js';
import { refreshPolicy } from '../api/refresh-policy.js';
import styles from './components.module.css';
import { ControlPlaneStatus } from './status.js';

const navigation = [
  ['Board', '/board'],
  ['Runs', '/runs'],
  ['Work', '/work'],
  ['Events', '/events'],
  ['Observability', '/observability'],
  ['Health', '/health'],
  ['Configuration', '/configuration'],
] as const;
export function AppShell({ children }: { readonly children: ReactNode }) {
  const online = useOnlineStatus();
  const client = useApiClient();
  const health = useQuery({
    queryKey: queryKeys.system.health,
    queryFn: ({ signal }) => client.system.health(signal),
    refetchInterval: refreshPolicy.health,
  });
  return (
    <div className={styles.shell}>
      {!online && (
        <div role="status" aria-live="polite">
          Connection lost; reconnecting
        </div>
      )}
      <header className={styles.header}>
        <span className={styles.brand!}>
          <img className={styles.brandLogo!} src={wakeLogo} alt="Wake logo" />
          Wake
        </span>
        {health.data && <span className={styles.brandVersion}>{health.data.data.version}</span>}
      </header>
      <div className={styles.statusBand} role="status" aria-label="Control plane">
        <ControlPlaneStatus />
      </div>
      <nav className={styles.nav} aria-label="Primary">
        {navigation.map(([label, path]) => (
          <NavLink key={path} to={path}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener('online', connected);
    window.addEventListener('offline', disconnected);
    return () => {
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', disconnected);
    };
  }, []);
  return online;
}
