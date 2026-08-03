import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEventResponse } from '../../../../api/contracts/index.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { CursorPagination, useCursorNavigation } from '../../components/cursor-pagination.js';
import { LocalTime } from '../../components/local-time.js';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StaleIndicator,
} from '../../components/primitives.js';
import styles from '../features.module.css';

export function EventsPage() {
  const client = useApiClient();
  const navigation = useCursorNavigation();
  return (
    <EventsCollection
      key={navigation.cursor ?? 'initial'}
      client={client}
      navigation={navigation}
    />
  );
}

function EventsCollection({
  client,
  navigation,
}: {
  readonly client: ReturnType<typeof useApiClient>;
  readonly navigation: ReturnType<typeof useCursorNavigation>;
}) {
  const cursors = useRef({ page: navigation.cursor, live: navigation.cursor });
  const [records, setRecords] = useState<AuditEventResponse[]>([]);
  const query = useQuery({
    queryKey: queryKeys.events.list(navigation.cursor),
    queryFn: async ({ signal }) => {
      return client.events.list(cursors.current.live, undefined, signal);
    },
    refetchInterval: (state) =>
      state.state.data?.page.hasMore === true ? false : refreshPolicy.events,
  });
  useEffect(() => {
    if (query.data === undefined) return;
    setRecords((current) => mergeBoundedEvents(current, query.data.items));
    if (!query.data.page.hasMore && query.data.page.nextCursor !== null)
      cursors.current.live = query.data.page.nextCursor;
  }, [query.data]);
  return (
    <>
      <PageHeader
        title="Events"
        actions={<StaleIndicator refreshing={query.isFetching} stale={query.isStale} />}
      />
      {query.isPending ? (
        <LoadingState label="Loading events" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <EventsFeed records={records} />
          {query.data && (
            <CursorPagination
              navigation={navigation}
              nextCursor={query.data.page.nextCursor}
              hasMore={query.data.page.hasMore}
            />
          )}
        </>
      )}
    </>
  );
}

export function EventRow({ record }: { readonly record: AuditEventResponse }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className={styles.event}>
      <button
        type="button"
        className={styles.eventButton}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <LocalTime value={record.occurredAt} />
        <span className={styles.eventType}>{record.type}</span>
        <span className={styles.eventId}>{record.id}</span>
        <span className={styles.eventChevron} aria-hidden="true">
          {expanded ? 'v' : '>'}
        </span>
      </button>
      {expanded && (
        <div className={styles.eventPayload}>
          <pre>{JSON.stringify(record, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}

export function EventsFeed({ records }: { readonly records: readonly AuditEventResponse[] }) {
  const [manualPaused, setManualPaused] = useState(false);
  const [scrolledAway, setScrolledAway] = useState(false);
  const [visible, setVisible] = useState(() => [...records]);
  const [buffer, setBuffer] = useState<AuditEventResponse[]>([]);
  const newest = useRef(visible.at(-1)?.position ?? -1);
  const paused = manualPaused || scrolledAway;
  useEffect(() => {
    const incoming = records.filter((record) => record.position > newest.current);
    if (incoming.length === 0) return;
    if (paused) setBuffer((current) => mergeBoundedEvents(current, incoming));
    else {
      setVisible((current) => mergeBoundedEvents(current, incoming));
      newest.current = incoming.at(-1)!.position;
    }
  }, [records, paused]);
  const ordered = useMemo(
    () => [...visible].sort((left, right) => left.position - right.position),
    [visible],
  );
  const resume = () => {
    setVisible((current) => mergeBoundedEvents(current, buffer));
    newest.current = Math.max(newest.current, ...buffer.map((record) => record.position));
    setBuffer([]);
    setManualPaused(false);
    setScrolledAway(false);
  };
  return (
    <section>
      <div className={styles.toolbar}>
        <Button
          type="button"
          variant="secondary"
          onClick={() => (paused ? resume() : setManualPaused(true))}
        >
          {paused ? 'Resume live view' : 'Pause live view'}
        </Button>
        {buffer.length > 0 && (
          <Button type="button" onClick={resume} aria-live="polite">
            {buffer.length} new {buffer.length === 1 ? 'event' : 'events'}
          </Button>
        )}
      </div>
      {ordered.length === 0 ? (
        <EmptyState>No events</EmptyState>
      ) : (
        <ol
          className={styles.eventList}
          onScroll={(event) => {
            const list = event.currentTarget;
            setScrolledAway(list.scrollHeight - list.scrollTop - list.clientHeight > 1);
          }}
        >
          {ordered.map((record) => (
            <EventRow record={record} key={record.id} />
          ))}
        </ol>
      )}
    </section>
  );
}

export function mergeBoundedEvents(
  current: readonly AuditEventResponse[],
  incoming: readonly AuditEventResponse[],
  limit = 200,
): AuditEventResponse[] {
  const byId = new Map([...current, ...incoming].map((record) => [record.id, record]));
  return [...byId.values()].sort((left, right) => left.position - right.position).slice(-limit);
}
