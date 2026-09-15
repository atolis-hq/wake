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
  tableClassName,
}: {
  readonly caption: string;
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly columns: readonly DataColumn<Row>[];
  readonly tableClassName?: string;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={[styles.table, tableClassName].filter(Boolean).join(' ')}>
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
                <td key={column.label} data-label={column.label}>
                  <div>{column.render(row)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
