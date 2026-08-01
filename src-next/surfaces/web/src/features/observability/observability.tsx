import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '../../components/primitives.js';
import { Tile } from '../../components/tile.js';
import styles from '../features.module.css';

export function ObservabilityPage() {
  const client = useApiClient();
  const query = useQuery({
    queryKey: queryKeys.observability.metrics,
    queryFn: ({ signal }) => client.observability.metrics(signal),
    refetchInterval: refreshPolicy.observability,
  });
  return (
    <>
      <PageHeader
        title="Observability"
        actions={
          <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
            Refresh metrics
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState label="Loading metrics" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : Object.keys(query.data?.data.values ?? {}).length === 0 ? (
        <EmptyState>No metrics available</EmptyState>
      ) : (
        <div className={styles.tiles}>
          {Object.entries(query.data!.data.values).map(([name, value]) => (
            <Tile key={name} label={name} value={String(value)} />
          ))}
        </div>
      )}
    </>
  );
}
