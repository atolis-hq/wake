import type { ReactNode } from 'react';
import styles from './components.module.css';

export function Chip({
  children,
  variant = 'default',
}: {
  readonly children: ReactNode;
  readonly variant?: 'default' | 'outline';
}) {
  return (
    <span className={`${styles.chip} ${variant === 'outline' ? styles.chipOutline : ''}`}>
      {children}
    </span>
  );
}
