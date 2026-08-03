import { Link, useLocation } from 'react-router';
import type { BoardCardResponse } from '../../../../api/contracts/index.js';
import { Chip } from '../../components/chip.js';
import { fmtAge, fmtCompact, fmtCost } from '../../components/format.js';
import styles from '../features.module.css';

export function BoardCard({
  item,
  background,
}: {
  readonly item: BoardCardResponse;
  readonly background: ReturnType<typeof useLocation>;
}) {
  return (
    <li className={styles.card} aria-label={item.objective}>
      <Link
        className={styles.cardLink!}
        to={`/work/${encodeURIComponent(item.workItemKey)}`}
        state={{ background }}
      >
        {item.externalRef !== undefined && (
          <span className={styles.cardRef}>{item.externalRef}</span>
        )}
        <span className={styles.cardTitle}>{item.objective}</span>
        <span className={styles.cardMeta}>
          <Chip variant="outline">{item.condition}</Chip>
          {item.awaitingApproval === true && <Chip variant="outline">awaiting approval</Chip>}
          {item.workflowName !== undefined && <Chip variant="outline">{item.workflowName}</Chip>}
          {item.stage !== undefined && <Chip variant="outline">{item.stage}</Chip>}
        </span>
        <span className={styles.cardStats}>
          {`${item.runCount} runs · since ${item.dwellSince} · ${fmtCost(item.totalCostUsd)} · ${fmtCompact(item.totalTokens)} tokens`}
        </span>
        {item.activeRun !== undefined && (
          <div className={styles.childRun}>
            <span className={styles.childRunDot} aria-hidden="true" />
            <div>
              <div className={styles.childRunTitle}>{`${item.activeRun.action} running`}</div>
              <div className={styles.childRunMeta}>
                {[item.activeRun.runnerName, fmtAge(item.activeRun.startedAt)]
                  .filter((part): part is string => part !== undefined)
                  .join(' · ')}
              </div>
            </div>
          </div>
        )}
      </Link>
    </li>
  );
}
