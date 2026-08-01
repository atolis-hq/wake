import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router';
import wakeLogo from '../../../../../assets/wake-logo.svg';
import { ControlPlaneStatus } from './status.js';
import styles from './components.module.css';

const navigation = [
  ['Board', '/board'],
  ['Work', '/work'],
  ['Events', '/events'],
  ['Runs', '/runs'],
  ['Observability', '/observability'],
  ['Health', '/health'],
  ['Configuration', '/configuration'],
] as const;
export function AppShell({ children }: { readonly children: ReactNode }) {
  const online = useOnlineStatus();
  return (
    <div className={styles.shell}>
      {!online && (
        <div role="status" aria-live="polite">
          Connection lost; reconnecting
        </div>
      )}
      <header className={styles.header}>
        <NavLink className={styles.brand!} to="/board">
          <img className={styles.brandLogo!} src={wakeLogo} alt="Wake logo" />
          WAKE
        </NavLink>
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
