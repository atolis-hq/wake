import styles from './components.module.css';

export function Tile({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className={styles.tile} role="group" aria-label={label}>
      <div className={styles.tileValue}>{value}</div>
      <div className={styles.tileLabel}>{label}</div>
    </div>
  );
}
