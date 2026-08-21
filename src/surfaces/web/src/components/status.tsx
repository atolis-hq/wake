import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiProblem } from '../api/client.js';
import { useApiClient } from '../api/context.js';
import { queryKeys } from '../api/query-keys.js';
import { refreshPolicy } from '../api/refresh-policy.js';
import styles from './components.module.css';
import { Button, MutationFeedback, StatusBadge } from './primitives.js';

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
  const pauseMutation = useMutation({
    mutationKey: ['control-plane', 'pause'],
    mutationFn: (idempotencyKey: string) => client.controlPlane.pause(idempotencyKey),
    onSuccess: () => cache.invalidateQueries({ queryKey: queryKeys.controlPlane.status }),
  });
  const resumeMutation = useMutation({
    mutationKey: ['control-plane', 'resume'],
    mutationFn: (idempotencyKey: string) => client.controlPlane.resume(idempotencyKey),
    onSuccess: () => cache.invalidateQueries({ queryKey: queryKeys.controlPlane.status }),
  });
  const tickMutation = useMutation({
    mutationKey: ['control-plane', 'advance-command'],
    mutationFn: (idempotencyKey: string) => client.controlPlane.tick(idempotencyKey),
    onSuccess: async (response) => {
      cache.setQueryData(queryKeys.controlPlane.status, response.data.result);
      await Promise.all([
        cache.invalidateQueries({ queryKey: queryKeys.work.all }),
        cache.invalidateQueries({ queryKey: queryKeys.board.list() }),
        cache.invalidateQueries({ queryKey: queryKeys.status.get }),
        cache.invalidateQueries({ queryKey: queryKeys.execution.runs }),
        cache.invalidateQueries({ queryKey: queryKeys.execution.runners }),
        cache.invalidateQueries({ queryKey: queryKeys.system.health }),
        cache.invalidateQueries({ queryKey: queryKeys.observability.metrics(7) }),
      ]);
    },
  });
  const conflict =
    tickMutation.error instanceof ApiProblem && tickMutation.error.problem.status === 409
      ? `Conflict: ${tickMutation.error.problem.title}`
      : tickMutation.error?.message;
  const maintenanceLease = status.data?.data.maintenanceLease;
  // A maintenance lease pauses every resident loop the same way an operator
  // pause does (see isRuntimePaused), but the status API's `paused` field only
  // reflects the operator toggle. Fold the lease in here so the dispatch badge
  // never reads "active" while maintenance is actually blocking dispatch.
  const dispatchPaused = status.data?.data.paused === true || maintenanceLease !== undefined;
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
      {status.data?.data.paused ? (
        <Button
          type="button"
          disabled={resumeMutation.isPending}
          onClick={() => resumeMutation.mutate(commandKey('resume'))}
        >
          Resume ticks
        </Button>
      ) : (
        <>
          <Button
            type="button"
            disabled={pauseMutation.isPending}
            onClick={() => pauseMutation.mutate(commandKey('pause'))}
          >
            Pause ticks
          </Button>
          <Button
            type="button"
            className={styles.tickButton!}
            disabled={tickMutation.isPending}
            onClick={() => tickMutation.mutate(commandKey('tick'))}
          >
            Tick now
          </Button>
        </>
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
      <MutationFeedback
        pending={tickMutation.isPending}
        {...(conflict === undefined ? {} : { message: conflict })}
      />
    </div>
  );
}
function commandKey(action: string): string {
  return `web:${action}:${globalThis.crypto.randomUUID()}`;
}
