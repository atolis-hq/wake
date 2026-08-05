import type { ReactNode } from 'react';
import styles from './components.module.css';

export function Chip({
  children,
  variant = 'default',
  title,
}: {
  readonly children: ReactNode;
  readonly variant?: 'default' | 'outline';
  readonly title?: string;
}) {
  return (
    <span
      className={`${styles.chip} ${variant === 'outline' ? styles.chipOutline : ''}`}
      title={title}
    >
      {children}
    </span>
  );
}
