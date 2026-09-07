import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '../api/context.js';
import { queryKeys } from '../api/query-keys.js';
import { refreshPolicy } from '../api/refresh-policy.js';
import styles from './components.module.css';
import { Button, StatusBadge } from './primitives.js';

export function ControlPlaneStatus() {
  const client = useApiClient();
  const cache = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.controlPlane.status,
    queryFn: ({ signal }) => client.controlPlane.status(signal),
    refetchInterval: refreshPolicy.status,
  });
  const runners = useQuery({
    queryKey: queryKeys.execution.runners,
    queryFn: ({ signal }) => client.execution.runners(signal),
    refetchInterval: refreshPolicy.runners,
  });
  const pausedRunners = runners.data?.items.filter((runner) => !runner.available) ?? [];
  const unpauseMutation = useMutation({
    mutationKey: ['control-plane', 'unpause-runner'],
    mutationFn: (runnerId: string) =>
      client.execution.unpauseRunner(runnerId, commandKey('unpause')),
    onSuccess: () => cache.invalidateQueries({ queryKey: queryKeys.execution.runners }),
  });
  const pauseDispatchMutation = useMutation({
    mutationKey: ['control-plane', 'pause-dispatch'],
    mutationFn: (idempotencyKey: string) => client.controlPlane.pauseDispatch(idempotencyKey),
    onSuccess: () => cache.invalidateQueries({ queryKey: queryKeys.controlPlane.status }),
  });
  const resumeDispatchMutation = useMutation({
    mutationKey: ['control-plane', 'resume-dispatch'],
    mutationFn: (idempotencyKey: string) => client.controlPlane.resumeDispatch(idempotencyKey),
    onSuccess: () => cache.invalidateQueries({ queryKey: queryKeys.controlPlane.status }),
  });
  const maintenanceLease = status.data?.data.maintenanceLease;
  // A maintenance lease pauses every resident loop the same way an operator
  // pause does (see isRuntimePaused), but the status API's `dispatchPaused` field only
  // reflects the operator toggle. Fold the lease in here so the dispatch badge
  // never reads "active" while maintenance is actually blocking dispatch.
  const dispatchPaused =
    status.data?.data.dispatchPaused === true || maintenanceLease !== undefined;
  return (
    <div className={styles.statusActions}>
      {status.data ? (
        <StatusBadge tone={dispatchPaused ? 'warning' : 'good'}>
          {dispatchPaused ? 'Dispatch paused' : 'Dispatch active'}
        </StatusBadge>
      ) : (
        <StatusBadge tone="bad">API unavailable</StatusBadge>
      )}
      {maintenanceLease ? (
        <StatusBadge
          tone={maintenanceLease.phase === 'failed' ? 'bad' : 'warning'}
          title={
            maintenanceLease.failure ?? `Maintenance lease held since ${maintenanceLease.startedAt}`
          }
        >
          Maintenance
        </StatusBadge>
      ) : null}
      {status.data?.data.dispatchPaused ? (
        <Button
          type="button"
          disabled={resumeDispatchMutation.isPending}
          onClick={() => resumeDispatchMutation.mutate(commandKey('resume-dispatch'))}
        >
          Resume dispatch
        </Button>
      ) : (
        <Button
          type="button"
          disabled={pauseDispatchMutation.isPending}
          onClick={() => pauseDispatchMutation.mutate(commandKey('pause-dispatch'))}
        >
          Pause dispatch
        </Button>
      )}
      {pausedRunners.map((runner) => (
        <span key={runner.runnerId} className={styles.pauseControl!}>
          {runner.runnerId} paused
          <button
            type="button"
            disabled={unpauseMutation.isPending}
            onClick={() => unpauseMutation.mutate(runner.runnerId)}
          >
            Unpause
          </button>
        </span>
      ))}
    </div>
  );
}
function commandKey(action: string): string {
  return `web:${action}:${globalThis.crypto.randomUUID()}`;
}
