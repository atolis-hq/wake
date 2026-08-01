import { Link, useLocation } from 'react-router';
import type { WorkItemResponse } from '../../../../api/contracts/index.js';
import { Chip } from '../../components/chip.js';
import styles from '../features.module.css';

export function BoardCard({
  item,
  background,
}: {
  readonly item: WorkItemResponse;
  readonly background: ReturnType<typeof useLocation>;
}) {
  return (
    <li className={styles.card} aria-label={item.objective}>
      <Link
        className={styles.cardLink!}
        to={`/work/${encodeURIComponent(item.workItemKey)}`}
        state={{ background }}
      >
        <span className={styles.cardTitle}>{item.objective}</span>
        <span className={styles.cardMeta}>
          <Chip variant="outline">{item.state}</Chip>
          {item.relatedWorkItems.length > 0 && (
            <Chip variant="outline">{item.relatedWorkItems.length} related</Chip>
          )}
        </span>
        <span className={styles.cardStats}>{item.workItemId}</span>
      </Link>
    </li>
  );
}
