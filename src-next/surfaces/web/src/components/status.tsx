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
  const operatorStatus = useQuery({
    queryKey: queryKeys.status.get,
    queryFn: ({ signal }) => client.status.get(signal),
    refetchInterval: refreshPolicy.status,
  });
  const mutation = useMutation({
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
    mutation.error instanceof ApiProblem && mutation.error.problem.status === 409
      ? `Conflict: ${mutation.error.problem.title}`
      : mutation.error?.message;
  return (
    <div className={styles.statusActions}>
      {status.data ? (
        <StatusBadge tone={status.data.data.paused ? 'warning' : 'good'}>
          {status.data.data.paused ? 'Dispatch paused' : 'Dispatch active'}
        </StatusBadge>
      ) : (
        <StatusBadge tone="bad">API unavailable</StatusBadge>
      )}
      {Object.entries(operatorStatus.data?.data?.conditionCounts ?? {}).map(
        ([condition, count]) => (
          <StatusBadge key={condition} tone="neutral">{`${condition}: ${count}`}</StatusBadge>
        ),
      )}
      <Button
        type="button"
        variant="secondary"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(commandKey('advance'))}
      >
        Advance
      </Button>
      <MutationFeedback
        pending={mutation.isPending}
        {...(conflict === undefined ? {} : { message: conflict })}
      />
    </div>
  );
}
function commandKey(action: string): string {
  return `web:${action}:${globalThis.crypto.randomUUID()}`;
}
