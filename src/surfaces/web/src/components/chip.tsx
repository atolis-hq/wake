import type { ReactNode } from 'react';
import styles from './components.module.css';

export function Chip({
  children,
  variant = 'default',
  tone = 'neutral',
  title,
}: {
  readonly children: ReactNode;
  readonly variant?: 'default' | 'outline';
  readonly tone?: 'neutral' | 'good' | 'warning' | 'bad' | 'cold' | 'info';
  readonly title?: string;
}) {
  return (
    <span
      className={`${styles.chip} ${variant === 'outline' ? styles.chipOutline : ''} ${
        tone === 'neutral' ? '' : styles[tone]
      }`}
      title={title}
    >
      {children}
    </span>
  );
}
