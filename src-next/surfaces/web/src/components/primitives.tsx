import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './components.module.css';

export const PageHeader = ({
  title,
  actions,
}: {
  readonly title?: string;
  readonly actions?: ReactNode;
}) => (
  <div className={styles.pageHeader}>
    {title !== undefined && <h1>{title}</h1>}
    {actions}
  </div>
);
export const Panel = ({
  children,
  labelledBy,
}: {
  readonly children: ReactNode;
  readonly labelledBy?: string;
}) => (
  <section className={styles.panel} aria-labelledby={labelledBy}>
    {children}
  </section>
);
export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: 'primary' | 'secondary' }) {
  return (
    <button
      {...props}
      className={[styles.button, variant === 'secondary' ? styles.secondary : '', className]
        .filter(Boolean)
        .join(' ')}
    />
  );
}
export function StatusBadge({
  children,
  tone = 'neutral',
}: {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'good' | 'warning' | 'bad';
}) {
  return (
    <span className={`${styles.badge} ${tone === 'neutral' ? '' : styles[tone]!}`}>
      <span>{children}</span>
    </span>
  );
}
export const LoadingState = ({ label = 'Loading' }: { readonly label?: string }) => (
  <div className={styles.state} role="status" aria-live="polite">
    {label}…
  </div>
);
export const EmptyState = ({ children }: { readonly children: ReactNode }) => (
  <div className={styles.state}>{children}</div>
);
export const ErrorState = ({
  error,
  retry,
}: {
  readonly error: Error;
  readonly retry?: () => void;
}) => (
  <div className={`${styles.state} ${styles.error}`} role="alert">
    <p>{error.message}</p>
    {retry && (
      <Button type="button" onClick={retry}>
        Retry
      </Button>
    )}
  </div>
);
export const MutationFeedback = ({
  pending,
  message,
}: {
  readonly pending: boolean;
  readonly message?: string;
}) => (
  <div className={`${styles.live} ${styles.stale}`} role="status" aria-live="polite">
    {pending ? 'Command pending…' : message}
  </div>
);
export const JsonViewer = ({ value }: { readonly value: unknown }) => (
  <details>
    <summary>Structured details</summary>
    <pre className={styles.json}>{JSON.stringify(value, null, 2)}</pre>
  </details>
);
