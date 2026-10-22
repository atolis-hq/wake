import styles from '../features/features.module.css';

export function WorkflowIcon() {
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

export function StageIcon() {
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
