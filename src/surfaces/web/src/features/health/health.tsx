import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { DataTable } from '../../components/data-table.js';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
} from '../../components/primitives.js';
import styles from '../features.module.css';

export function HealthPage() {
  const client = useApiClient();
  const [tab, setTab] = useState<'overview' | 'adapters' | 'runners' | 'maintenance'>('overview');
  const tabs = [
    ['overview', 'Overview'],
    ['adapters', 'Adapter health'],
    ['runners', 'Runner availability'],
    ['maintenance', 'Maintenance recovery'],
  ] as const;
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>) => {
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    const current = buttons.indexOf(event.currentTarget);
    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % buttons.length
        : event.key === 'ArrowLeft'
          ? (current - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    buttons[next]?.click();
    buttons[next]?.focus();
  };
  const cache = useQueryClient();
  const health = useQuery({
    queryKey: queryKeys.system.health,
    queryFn: ({ signal }) => client.system.health(signal),
    refetchInterval: refreshPolicy.health,
  });
  const runners = useQuery({
    queryKey: queryKeys.execution.runners,
    queryFn: ({ signal }) => client.execution.runners(signal),
    refetchInterval: refreshPolicy.runners,
  });
  const controlPlane = useQuery({
    queryKey: queryKeys.controlPlane.status,
    queryFn: ({ signal }) => client.controlPlane.status(signal),
    refetchInterval: refreshPolicy.status,
  });
  const clearMaintenance = useMutation({
    mutationKey: ['control-plane', 'clear-maintenance'],
    mutationFn: (attemptId: string) =>
      client.controlPlane.clearMaintenance(attemptId, crypto.randomUUID()),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: queryKeys.controlPlane.status });
      void cache.invalidateQueries({ queryKey: queryKeys.system.health });
    },
  });
  const toggleRunner = async (runnerId: string, paused: boolean) => {
    const idempotencyKey = crypto.randomUUID();
    if (paused) await client.execution.unpauseRunner(runnerId, idempotencyKey);
    else await client.execution.pauseRunner(runnerId, idempotencyKey);
    await runners.refetch();
  };
  return (
    <>
      <div className={styles.tabs} role="tablist" aria-label="Health sections">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`health-${value}-tab`}
            aria-controls={`health-${value}-panel`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onKeyDown={navigateTabs}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <section
        className={styles.tabPanel}
        role="tabpanel"
        id={`health-${tab}-panel`}
        aria-labelledby={`health-${tab}-tab`}
      >
        <PageHeader
          actions={
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void health.refetch();
                void runners.refetch();
                void controlPlane.refetch();
              }}
            >
              Refresh health
            </Button>
          }
        />
        {tab === 'overview' && (
          <>
            {health.isPending ? (
              <LoadingState label="Checking health" />
            ) : health.error && !health.data ? (
              <ErrorState error={health.error} retry={() => void health.refetch()} />
            ) : (
              health.data && <HealthOverview health={health.data.data} />
            )}
          </>
        )}
        {tab === 'maintenance' && (
          <>
            {controlPlane.isPending ? (
              <LoadingState label="Checking maintenance" />
            ) : controlPlane.error && !controlPlane.data ? (
              <ErrorState error={controlPlane.error} retry={() => void controlPlane.refetch()} />
            ) : controlPlane.data?.data.maintenanceLease ? (
              <>
                <h2>Maintenance recovery</h2>
                <Panel>
                  <StatusBadge
                    tone={
                      controlPlane.data.data.maintenanceLease.phase === 'failed' ? 'bad' : 'warning'
                    }
                  >
                    {controlPlane.data.data.maintenanceLease.phase}
                  </StatusBadge>
                  <p>Started: {controlPlane.data.data.maintenanceLease.startedAt}</p>
                  {controlPlane.data.data.maintenanceLease.failure ? (
                    <p>Failure: {controlPlane.data.data.maintenanceLease.failure}</p>
                  ) : (
                    <EmptyState>No maintenance lease</EmptyState>
                  )}
                  {controlPlane.data.data.maintenanceLease.phase === 'failed' ? (
                    <Button
                      type="button"
                      disabled={clearMaintenance.isPending}
                      onClick={() => {
                        if (
                          !window.confirm(
                            'Clear this failed maintenance lease? This immediately resumes intake and dispatch. Confirm the update attempt is abandoned.',
                          )
                        )
                          return;
                        clearMaintenance.mutate(
                          controlPlane.data!.data.maintenanceLease!.attemptId,
                        );
                      }}
                    >
                      Clear failed maintenance
                    </Button>
                  ) : (
                    <p>Maintenance is active and cannot be cleared until the update fails.</p>
                  )}
                </Panel>
              </>
            ) : (
              <EmptyState>No maintenance lease</EmptyState>
            )}
          </>
        )}
        {tab === 'adapters' && (
          <>
            <h2>Adapter health</h2>
            {health.isPending ? (
              <LoadingState label="Checking adapters" />
            ) : health.error && !health.data ? (
              <ErrorState error={health.error} retry={() => void health.refetch()} />
            ) : health.data && (health.data.data.adapters?.length ?? 0) === 0 ? (
              <EmptyState>No adapter health reported</EmptyState>
            ) : (
              health.data && (
                <DataTable
                  caption="Adapter health"
                  tableClassName={styles.adapterHealthTable}
                  rows={health.data.data.adapters!}
                  rowKey={(check) => `${check.adapter}:${check.scope}:${check.channel}`}
                  columns={[
                    { label: 'Adapter', render: (check) => check.adapter },
                    { label: 'Scope', render: (check) => check.scope },
                    { label: 'Channel', render: (check) => check.channel },
                    {
                      label: 'Status',
                      render: (check) => (
                        <StatusBadge tone={check.status === 'ok' ? 'good' : 'warning'}>
                          {check.status}
                        </StatusBadge>
                      ),
                    },
                    { label: 'Successes', render: (check) => check.successCount },
                    { label: 'Failures', render: (check) => check.failureCount },
                    { label: 'Detail', render: (check) => check.detail ?? '—' },
                  ]}
                />
              )
            )}
          </>
        )}
        {tab === 'runners' && (
          <>
            <h2>Runner availability</h2>
            {runners.isPending ? (
              <LoadingState label="Loading runners" />
            ) : runners.error && !runners.data ? (
              <ErrorState error={runners.error} retry={() => void runners.refetch()} />
            ) : (runners.data?.items.length ?? 0) === 0 ? (
              <EmptyState>No runners configured</EmptyState>
            ) : (
              <DataTable
                caption="Runner availability"
                rows={runners.data!.items}
                rowKey={(runner) => runner.runnerId}
                columns={[
                  { label: 'Runner', render: (runner) => runner.runnerId },
                  {
                    label: 'Availability',
                    render: (runner) => (
                      <StatusBadge tone={runner.available ? 'good' : 'warning'}>
                        {runner.status}
                      </StatusBadge>
                    ),
                  },
                  { label: 'Detail', render: (runner) => runner.detail ?? '—' },
                  {
                    label: 'Control',
                    render: (runner) => (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void toggleRunner(runner.runnerId, !runner.available)}
                      >
                        {runner.available ? 'Pause' : 'Unpause'}
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </>
        )}
      </section>
    </>
  );
}

function HealthOverview({
  health,
}: {
  readonly health: {
    readonly status: 'ok' | 'degraded';
    readonly version: string;
    readonly checkedAt: string;
    readonly checks?: readonly {
      readonly name: string;
      readonly status: 'ok' | 'degraded';
      readonly detail?: string;
    }[];
  };
}) {
  const checks = health.checks ?? [];
  const healthy = checks.filter((check) => check.status === 'ok');
  const degraded = checks.filter((check) => check.status === 'degraded');
  const orderedChecks = [...degraded, ...healthy];
  return (
    <div className={styles.healthOverview}>
      <Panel>
        <div className={styles.healthSummary}>
          <div>
            <p className={styles.healthEyebrow}>System health</p>
            <StatusBadge tone={health.status === 'ok' ? 'good' : 'warning'}>
              Wake {health.status}
            </StatusBadge>
          </div>
          <dl className={styles.healthMeta}>
            <div>
              <dt>Version</dt>
              <dd>{health.version}</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>
                <time dateTime={health.checkedAt}>
                  {new Date(health.checkedAt).toLocaleString()}
                </time>
              </dd>
            </div>
          </dl>
        </div>
      </Panel>
      <Panel labelledBy="health-checks-title">
        <div className={styles.healthChecksHeader}>
          <div>
            <p className={styles.healthEyebrow}>Checks</p>
            <h2 id="health-checks-title">System checks</h2>
          </div>
          <div className={styles.healthCounts} aria-label="Health check counts">
            <span>{healthy.length} healthy</span>
            {degraded.length > 0 && <span>{degraded.length} need attention</span>}
          </div>
        </div>
        {orderedChecks.length === 0 ? (
          <EmptyState>No health checks reported</EmptyState>
        ) : (
          <ul className={styles.healthCheckList}>
            {orderedChecks.map((check) => (
              <li key={check.name}>
                <div>
                  <strong>{check.name}</strong>
                  {check.detail && <span>{check.detail}</span>}
                </div>
                <StatusBadge tone={check.status === 'ok' ? 'good' : 'warning'}>
                  {check.status === 'ok' ? 'Healthy' : 'Needs attention'}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
