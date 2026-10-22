import { Link } from 'react-router';
import type { WorkDetailResponse } from '../../../../api/contracts/work.js';
import { DataTable } from '../../components/data-table.js';
import { Button } from '../../components/primitives.js';

export type WorkArtifact = WorkDetailResponse['artifacts'][number];

const relationLabels = { granted: 'Granted', shared: 'Shared context' } as const;

/** Artifacts a work item published, or (with `showSource`) ones other work made available to it. */
export function ArtifactTable({
  caption,
  rows,
  showSource = false,
  onView,
}: {
  readonly caption: string;
  readonly rows: readonly WorkArtifact[];
  readonly showSource?: boolean;
  readonly onView: (artifact: WorkArtifact) => void;
}) {
  return (
    <DataTable
      caption={caption}
      rows={rows}
      rowKey={(artifact) => `${artifact.source?.workItemKey ?? ''}/${artifact.revisionId}`}
      columns={[
        ...(showSource
          ? [
              {
                label: 'From',
                render: (artifact: WorkArtifact) =>
                  artifact.source === undefined ? null : (
                    <>
                      <Link to={`/work/${encodeURIComponent(artifact.source.workItemKey)}`}>
                        {artifact.producer}
                      </Link>{' '}
                      ({relationLabels[artifact.source.relation]})
                    </>
                  ),
              },
            ]
          : [{ label: 'Producer', render: (artifact: WorkArtifact) => artifact.producer }]),
        {
          label: 'Path',
          render: (artifact) => <a href={artifact.href}>{artifact.path}</a>,
        },
        {
          label: 'View',
          render: (artifact) =>
            /\.md$/i.test(artifact.path) ? (
              <Button
                variant="secondary"
                onClick={() => onView(artifact)}
                aria-label={`View ${artifact.path}`}
              >
                View
              </Button>
            ) : null,
        },
        { label: 'Type', render: (artifact) => artifact.mediaType ?? 'binary' },
        { label: 'Bytes', render: (artifact) => artifact.byteLength?.toLocaleString() ?? '?' },
      ]}
    />
  );
}
