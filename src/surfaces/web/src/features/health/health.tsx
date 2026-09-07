import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export function HealthPage() {
  const client = useApiClient();
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
      {health.isPending ? (
        <LoadingState label="Checking health" />
      ) : health.error && !health.data ? (
        <ErrorState error={health.error} retry={() => void health.refetch()} />
      ) : (
        health.data && (
          <Panel>
            <StatusBadge tone={health.data.data.status === 'ok' ? 'good' : 'warning'}>
              Wake {health.data.data.status}
            </StatusBadge>
            {health.data.data.checks?.map((check) => (
              <p key={check.name}>
                {check.name}: {check.status}
                {check.detail ? ` — ${check.detail}` : ''}
              </p>
            ))}
          </Panel>
        )
      )}
      {controlPlane.data?.data.maintenanceLease ? (
        <>
          <h2>Maintenance recovery</h2>
          <Panel>
            <StatusBadge
              tone={controlPlane.data.data.maintenanceLease.phase === 'failed' ? 'bad' : 'warning'}
            >
              {controlPlane.data.data.maintenanceLease.phase}
            </StatusBadge>
            <p>Started: {controlPlane.data.data.maintenanceLease.startedAt}</p>
            {controlPlane.data.data.maintenanceLease.failure ? (
              <p>Failure: {controlPlane.data.data.maintenanceLease.failure}</p>
            ) : null}
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
                  clearMaintenance.mutate(controlPlane.data!.data.maintenanceLease!.attemptId);
                }}
              >
                Clear failed maintenance
              </Button>
            ) : (
              <p>Maintenance is active and cannot be cleared until the update fails.</p>
            )}
          </Panel>
        </>
      ) : null}
      <h2>Adapter health</h2>
      {health.data && (health.data.data.adapters?.length ?? 0) === 0 ? (
        <EmptyState>No adapter health reported</EmptyState>
      ) : (
        health.data && (
          <DataTable
            caption="Adapter health"
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
  );
}
