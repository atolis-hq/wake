import {
  faArrowDownWideShort,
  faBars,
  faChartLine,
  faChevronRight,
  faClockRotateLeft,
  faColumns,
  faFilter,
  faHeartPulse,
  faListCheck,
  faPlay,
  faSliders,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import wakeLogo from '../../../../../assets/wake-logo.svg';
import { BoardCondition } from '../../../api/contracts/index.js';
import { useApiClient } from '../api/context.js';
import { queryKeys } from '../api/query-keys.js';
import { refreshPolicy } from '../api/refresh-policy.js';
import styles from './shell.module.css';
import { ControlPlaneStatus } from './status.js';

const groups = [
  BoardCondition.NeedsInput,
  BoardCondition.Error,
  BoardCondition.Active,
  BoardCondition.Ready,
  BoardCondition.Finished,
];
const labels: Record<string, string> = {
  'needs-input': 'Needs input',
  error: 'Error',
  active: 'Active',
  ready: 'Ready',
  finished: 'Finished',
};
function preference(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Preferences are optional. */
  }
}
export function AppShell({ children }: { readonly children: ReactNode }) {
  const online = useOnlineStatus();
  const client = useApiClient();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(
    () => preference('wake:sidebar:collapsed', 'false') === 'true',
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobile, setMobile] = useState(
    () => window.matchMedia?.('(max-width: 48rem)').matches ?? false,
  );
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 48rem)');
    if (!media) return;
    const update = () => {
      setMobile(media.matches);
      setMobileOpen(false);
    };
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
      clearTimeout(scrollTimer.current);
    };
  }, []);
  const [width, setWidth] = useState(() =>
    Math.min(440, Math.max(220, Number(preference('wake:sidebar:width', '280')) || 280)),
  );
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [sort, setSort] = useState('recent');
  const toggle = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const health = useQuery({
    queryKey: queryKeys.system.health,
    queryFn: ({ signal }) => client.system.health(signal),
    refetchInterval: refreshPolicy.health,
  });
  const board = useQuery({
    queryKey: queryKeys.board.list(),
    queryFn: ({ signal }) => client.board.list(undefined, signal),
    refetchInterval: refreshPolicy.board,
  });
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (mobileOpen) sidebar.current?.querySelector<HTMLAnchorElement>('a')?.focus();
  }, [mobileOpen]);
  useEffect(() => {
    const selected = sidebar.current?.querySelector<HTMLAnchorElement>(
      'a[aria-current="page"][data-work-item]',
    );
    const group = selected?.closest('details');
    if (group) group.open = true;
    selected?.scrollIntoView?.({ block: 'nearest' });
  }, [location.pathname, board.data]);
  const items = [...(board.data?.items ?? [])]
    .filter((item) =>
      `${item.externalRef ?? ''} ${item.objective}`.toLowerCase().includes(filter.toLowerCase()),
    )
    .sort((a, b) =>
      sort === 'title'
        ? a.objective.localeCompare(b.objective)
        : (b.lastRunAt ?? b.dwellSince).localeCompare(a.lastRunAt ?? a.dwellSince),
    );
  return (
    <div
      className={styles.shell}
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
      data-collapsed={collapsed}
      data-mobile-open={mobileOpen}
    >
      <a className={styles.skip} href="#main-content">
        Skip to content
      </a>
      <header className={styles.header}>
        <button
          ref={toggle}
          className={styles.iconButton}
          aria-label="Toggle sidebar"
          aria-controls="app-sidebar"
          aria-expanded={mobile ? mobileOpen : !collapsed}
          onClick={() => {
            if (mobile) setMobileOpen(!mobileOpen);
            else {
              setCollapsed(!collapsed);
              save('wake:sidebar:collapsed', String(!collapsed));
            }
          }}
        >
          <FontAwesomeIcon icon={faBars} />
        </button>
        <NavLink to="/board" className={styles.brand}>
          <img src={wakeLogo} alt="Wake logo" />
          Wake
        </NavLink>
        {health.data && <span className={styles.version}>{health.data.data.version}</span>}
        <div className={styles.dispatch} role="status" aria-label="Control plane">
          <ControlPlaneStatus />
        </div>
      </header>
      {!online && (
        <div className={styles.offline} role="status">
          Connection lost; reconnecting
        </div>
      )}
      {mobileOpen && (
        <button
          className={styles.backdrop}
          aria-label="Close sidebar"
          onClick={() => {
            setMobileOpen(false);
            toggle.current?.focus();
          }}
        />
      )}
      <aside
        ref={sidebar}
        id="app-sidebar"
        className={styles.sidebar}
        aria-label="Sidebar"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setMobileOpen(false);
            toggle.current?.focus();
          }
          if (mobileOpen && event.key === 'Tab') {
            const focusable = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'a, button, input, select, summary',
              ),
            ).filter((element) => element.getClientRects().length > 0);
            if (event.shiftKey && document.activeElement === focusable[0]) {
              event.preventDefault();
              focusable.at(-1)?.focus();
            } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
              event.preventDefault();
              focusable[0]?.focus();
            }
          }
        }}
      >
        <nav className={styles.primary} aria-label="Primary">
          {(
            [
              ['Board', '/board', faColumns],
              ['Work items', '/work', faListCheck],
              ['Runs', '/runs', faPlay],
            ] as const
          ).map(([label, path, icon]) => (
            <NavLink end key={path} to={path}>
              <FontAwesomeIcon icon={icon} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className={styles.listHeading}>
          <h2>Work items</h2>
          <label className={styles.sort}>
            <FontAwesomeIcon icon={faArrowDownWideShort} />
            <select
              aria-label="Sort work items"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="recent">Recent</option>
              <option value="title">Title</option>
            </select>
          </label>
          <button
            className={styles.iconButton}
            aria-label="Filter work items"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen(!filterOpen)}
          >
            <FontAwesomeIcon icon={faFilter} />
          </button>
        </div>
        {filterOpen && (
          <input
            className={styles.filter}
            aria-label="Search work items"
            placeholder="Filter by title or resource ID..."
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        <div
          className={styles.workList}
          data-scrolling={scrolling}
          onScroll={() => {
            setScrolling(true);
            clearTimeout(scrollTimer.current);
            scrollTimer.current = setTimeout(() => setScrolling(false), 900);
          }}
        >
          {board.isPending && <p>Loading work items...</p>}
          {board.error && !board.data && (
            <button className={styles.iconButton} onClick={() => void board.refetch()}>
              Unable to load. Retry
            </button>
          )}
          {groups.map((condition) => (
            <details
              key={condition}
              open={condition !== BoardCondition.Finished}
              className={styles.group}
            >
              <summary>
                <FontAwesomeIcon icon={faChevronRight} className={styles.chevron} />
                {labels[condition]}
                <span className={styles.count}>
                  {items.filter((item) => item.condition === condition).length}
                </span>
              </summary>
              {items
                .filter((item) => item.condition === condition)
                .map((item) => (
                  <NavLink
                    key={item.workItemKey}
                    to={`/work/${encodeURIComponent(item.workItemKey)}`}
                    className={styles.workLink}
                    data-work-item
                  >
                    <span className={styles.ref}>{item.externalRef ?? item.workItemId}</span>
                    <span>{item.objective}</span>
                  </NavLink>
                ))}
            </details>
          ))}
          {filter && items.length === 0 && <p>No matching work items</p>}
        </div>
        <nav className={styles.footer} aria-label="Utilities">
          <NavLink to="/events">
            <FontAwesomeIcon icon={faClockRotateLeft} /> Events
          </NavLink>
          <NavLink to="/observability">
            <FontAwesomeIcon icon={faChartLine} /> Analytics
          </NavLink>
          <NavLink to="/configuration">
            <FontAwesomeIcon icon={faSliders} /> Config
          </NavLink>
          <NavLink to="/health">
            <FontAwesomeIcon icon={faHeartPulse} /> Health
          </NavLink>
        </nav>
        <div
          className={styles.resize}
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={440}
          aria-valuenow={width}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              const next = Math.min(
                440,
                Math.max(220, width + (event.key === 'ArrowRight' ? 16 : -16)),
              );
              setWidth(next);
              save('wake:sidebar:width', String(next));
            }
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              const next = Math.min(440, Math.max(220, event.clientX));
              setWidth(next);
              save('wake:sidebar:width', String(next));
            }
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        />
      </aside>
      <main id="main-content" className={styles.main} inert={mobile && mobileOpen}>
        {children}
      </main>
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
