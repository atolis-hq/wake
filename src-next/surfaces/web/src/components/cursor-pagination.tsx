import { useSearchParams } from 'react-router';
import { Button } from './primitives.js';
import styles from './components.module.css';

interface CursorNavigation {
  readonly cursor?: string;
  readonly hasPrevious: boolean;
  next(cursor: string): void;
  previous(): void;
  setFilter(name: string, value: string): void;
}

export function useCursorNavigation(): CursorNavigation {
  const [parameters, setParameters] = useSearchParams();
  const cursor = parameters.get('cursor') ?? undefined;
  const previous = parameters.getAll('previous');
  return {
    ...(cursor === undefined ? {} : { cursor }),
    hasPrevious: previous.length > 0,
    next(nextCursor) {
      const updated = new URLSearchParams(parameters);
      updated.append('previous', cursor ?? '');
      updated.set('cursor', nextCursor);
      setParameters(updated);
    },
    previous() {
      const prior = previous.at(-1);
      if (prior === undefined) return;
      const updated = new URLSearchParams(parameters);
      updated.delete('previous');
      for (const item of previous.slice(0, -1)) updated.append('previous', item);
      if (prior === '') updated.delete('cursor');
      else updated.set('cursor', prior);
      setParameters(updated);
    },
    setFilter(name, value) {
      const updated = new URLSearchParams(parameters);
      if (value === '') updated.delete(name);
      else updated.set(name, value);
      updated.delete('cursor');
      updated.delete('previous');
      setParameters(updated, { replace: true });
    },
  };
}

export function CursorPagination({
  navigation,
  nextCursor,
  hasMore,
}: {
  readonly navigation: CursorNavigation;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}) {
  return (
    <nav className={styles.pagination} aria-label="Collection pages">
      <Button
        type="button"
        variant="secondary"
        disabled={!navigation.hasPrevious}
        onClick={navigation.previous}
      >
        Previous page
      </Button>
      <Button
        type="button"
        variant="secondary"
        disabled={!hasMore || nextCursor === null}
        onClick={() => nextCursor !== null && navigation.next(nextCursor)}
      >
        Next page
      </Button>
    </nav>
  );
}
