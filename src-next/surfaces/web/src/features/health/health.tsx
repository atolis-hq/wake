import { useQuery } from '@tanstack/react-query';
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
