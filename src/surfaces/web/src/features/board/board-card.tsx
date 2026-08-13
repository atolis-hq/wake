import { Link, useLocation } from 'react-router';
import type { BoardCardResponse } from '../../../../api/contracts/index.js';
import { Chip } from '../../components/chip.js';
import { fmtCost, fmtDuration } from '../../components/format.js';
import { TokenUsage } from '../../components/token-usage.js';
import styles from '../features.module.css';

const badTones = new Set(['failed', 'cancelled', 'ambiguous']);
const warningTones = new Set(['blocked', 'rejected']);

function outcomeTone(outcome: string): 'good' | 'warning' | 'bad' | 'neutral' {
  if (badTones.has(outcome)) return 'bad';
  if (warningTones.has(outcome)) return 'warning';
  if (outcome === 'done') return 'good';
  return 'neutral';
}

function OutcomeIcon() {
  return (
    <svg
      className={styles.metaIcon}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.4 8.2 7.1 9.9 10.6 6.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ApprovalIcon() {
  return (
    <svg
      className={styles.metaIcon}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.5 2.5h7M4.5 13.5h7M5 2.5v2.4c0 .9.5 1.7 1.3 2.1l1.2.7-1.2.7c-.8.4-1.3 1.2-1.3 2.1v2.4M11 2.5v2.4c0 .9-.5 1.7-1.3 2.1l-1.2.7 1.2.7c.8.4 1.3 1.2 1.3 2.1v2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FrozenIcon() {
  return (
    <svg
      className={styles.metaIcon}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 1.75v12.5M2.6 4.875l10.8 6.25M2.6 11.125l10.8-6.25"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="m5.65 3.1-1.3 1.775m7.3 6.25-1.3 1.775M5.65 12.9l-1.3-1.775m7.3-6.25-1.3-1.775"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WorkflowIcon() {
  return (
    <svg
      className={styles.metaIcon}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4 5.1v5.8M5.4 4.2 10.6 6.9M5.4 11.8 10.6 9.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StageIcon() {
  return (
    <svg
      className={styles.metaIcon}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 2v12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M3.5 2.8h7l-1.8 2.6 1.8 2.6h-7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
          {item.frozen === true && (
            <Chip
              variant="outline"
              tone="cold"
              title="Automatic progress is paused while this work item is frozen"
            >
              <FrozenIcon />
              frozen
            </Chip>
          )}
          {item.lastRunOutcome !== undefined && item.lastRunOutcome !== 'done' && (
            <Chip
              variant="outline"
              tone={outcomeTone(item.lastRunOutcome)}
              title="Outcome of the most recent run"
            >
              <OutcomeIcon />
              {item.lastRunOutcome}
            </Chip>
          )}
          {item.awaitingApproval === true && (
            <Chip variant="outline" tone="warning" title="Waiting on human approval to continue">
              <ApprovalIcon />
              awaiting approval
            </Chip>
          )}
          {item.workflowName !== undefined && (
            <Chip variant="outline" title="Workflow driving this item">
              <WorkflowIcon />
              {item.workflowName}
            </Chip>
          )}
          {item.stage !== undefined && (
            <Chip variant="outline" title="Current lifecycle stage">
              <StageIcon />
              {item.stage}
            </Chip>
          )}
        </span>
        <span className={styles.cardStats}>
          {`${item.runCount} runs \u00b7 ${
            item.lastRunAgeMs === undefined
              ? 'no runs yet'
              : `last run ${fmtDuration(item.lastRunAgeMs)} ago`
          } \u00b7 ${fmtDuration(item.totalDurationMs)} total \u00b7 ${fmtCost(item.totalCostUsd)} \u00b7 `}
          <TokenUsage usage={item} /> usage tokens
        </span>
        {item.activeRun !== undefined && (
          <div className={styles.childRun}>
            <span className={styles.childRunDot} aria-hidden="true" />
            <div>
              <div className={styles.childRunTitle}>{`${item.activeRun.action} running`}</div>
              <div className={styles.childRunMeta}>
                {[item.activeRun.runnerName, fmtDuration(item.activeRun.elapsedMs)]
                  .filter((part): part is string => part !== undefined)
                  .join(' \u00b7 ')}
              </div>
            </div>
          </div>
        )}
      </Link>
    </li>
  );
}
