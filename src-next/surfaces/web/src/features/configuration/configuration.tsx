import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import {
  Button,
  ErrorState,
  JsonViewer,
  LoadingState,
  PageHeader,
  Panel,
} from '../../components/primitives.js';

export function ConfigurationPage() {
  const client = useApiClient();
  const query = useQuery({
    queryKey: queryKeys.system.configuration,
    queryFn: ({ signal }) => client.system.configuration(signal),
    refetchInterval: refreshPolicy.configuration,
  });
  return (
    <>
      <PageHeader
        actions={
          <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
            Refresh configuration
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState label="Loading redacted configuration" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        query.data && (
          <Panel>
            <p>Read-only effective configuration. Secrets are redacted by Wake.</p>
            <JsonViewer value={query.data.data.configuration} />
          </Panel>
        )
      )}
    </>
  );
}
