import { Link } from 'react-router';
import type { WorkDetailResponse } from '../../../../api/contracts/work.js';
import { StageIcon, WorkflowIcon } from '../../components/card-icons.js';
import { Chip } from '../../components/chip.js';
import styles from '../features.module.css';

type Delegation = NonNullable<WorkDetailResponse['delegation']>;

const workPath = (key: string) => '/work/' + encodeURIComponent(key);

function statusTone(status: string): 'good' | 'warning' | 'bad' | 'neutral' {
  if (status === 'completed') return 'good';
  if (status === 'blocked' || status === 'failed' || status === 'cancelled') return 'bad';
  if (status === 'waiting' || status === 'registration-pending') return 'warning';
  return 'neutral';
}

/** Parent and child navigation, kept beside the work's resources and styled like them. */
export function RelatedWork({
  delegation,
  workItemKey,
}: {
  readonly delegation: Delegation;
  /** The work item being viewed; links never point back at it. */
  readonly workItemKey: string;
}) {
  const parentKey = delegation.parentWorkItemKey;
  const rootKey =
    delegation.rootWorkItemKey !== workItemKey && delegation.rootWorkItemKey !== parentKey
      ? delegation.rootWorkItemKey
      : undefined;
  return (
    <section aria-labelledby="work-related">
      <h2 id="work-related" className={styles.sidebarSectionTitle}>
        Related work
      </h2>
      {(parentKey !== undefined || rootKey !== undefined) && (
        <p className={styles.relatedLinks}>
          {parentKey !== undefined && <Link to={workPath(parentKey)}>View parent</Link>}
          {rootKey !== undefined && <Link to={workPath(rootKey)}>View delivery root</Link>}
        </p>
      )}
      <ul className={styles.cards} aria-label="Child work">
        {delegation.children.map((child) => (
          <li key={child.workItemKey} className={styles.card}>
            <Link className={styles.cardLink} to={workPath(child.workItemKey)}>
              <span className={styles.cardRef}>{child.externalRef ?? child.workItemId}</span>
              <span className={styles.cardTitle}>{child.objective}</span>
              <span className={styles.cardMeta}>
                <Chip variant="outline" tone={statusTone(child.status)} title="Child status">
                  {child.status}
                </Chip>
                <Chip variant="outline" title="Workflow driving this item">
                  <WorkflowIcon />
                  {child.workflowName}
                </Chip>
                {child.currentStage !== undefined && (
                  <Chip variant="outline" title="Current lifecycle stage">
                    <StageIcon />
                    {child.currentStage}
                  </Chip>
                )}
              </span>
              {child.blockReason && <span className={styles.cardStats}>{child.blockReason}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
