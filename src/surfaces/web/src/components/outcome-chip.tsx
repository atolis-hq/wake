import styles from '../features/features.module.css';
import { Chip } from './chip.js';

const badOutcomes = new Set(['failed', 'cancelled', 'ambiguous']);
const warningOutcomes = new Set(['blocked', 'rejected']);
const infoOutcomes = new Set(['needs-clarification']);

function normalize(outcome: string): string {
  return outcome.toLowerCase().replaceAll('_', '-');
}

function outcomeTone(outcome: string): 'good' | 'warning' | 'bad' | 'info' | 'neutral' {
  const normalized = normalize(outcome);
  if (badOutcomes.has(normalized)) return 'bad';
  if (infoOutcomes.has(normalized)) return 'info';
  if (warningOutcomes.has(normalized)) return 'warning';
  if (normalized === 'done') return 'good';
  return 'neutral';
}

function outcomeLabel(outcome: string): string {
  return normalize(outcome) === 'needs-clarification' ? 'needs clarification' : outcome;
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

function QuestionIcon() {
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
        d="M6.1 6.3a1.9 1.9 0 1 1 2.75 1.7c-.6.32-.85.6-.85 1.2v.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="11.4" r="0.15" fill="currentColor" stroke="currentColor" />
    </svg>
  );
}

/** Renders a run/work outcome (a board's lastRunOutcome or a run's sentinel) as a status chip. */
export function OutcomeChip({
  outcome,
  title,
}: {
  readonly outcome: string;
  readonly title?: string;
}) {
  const Icon = normalize(outcome) === 'needs-clarification' ? QuestionIcon : OutcomeIcon;
  return (
    <Chip variant="outline" tone={outcomeTone(outcome)} {...(title === undefined ? {} : { title })}>
      <Icon />
      {outcomeLabel(outcome)}
    </Chip>
  );
}
