import type { ReactNode } from 'react';
import styles from './components.module.css';

interface DataColumn<Row> {
  readonly label: string;
  readonly render: (row: Row) => ReactNode;
}
export function DataTable<Row>({
  caption,
  rows,
  rowKey,
  columns,
}: {
  readonly caption: string;
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly columns: readonly DataColumn<Row>[];
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.label}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.label}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
