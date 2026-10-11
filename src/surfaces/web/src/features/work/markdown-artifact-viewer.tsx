import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import { useApiClient } from '../../api/context.js';
import { Button, ErrorState, LoadingState } from '../../components/primitives.js';
import styles from './markdown-artifact-viewer.module.css';

export function MarkdownArtifactViewer({
  workItemKey,
  artifact,
  onClose,
}: {
  readonly workItemKey: string;
  readonly artifact: { readonly revisionId: string; readonly path: string; readonly href: string };
  readonly onClose: () => void;
}) {
  const client = useApiClient();
  const query = useQuery({
    queryKey: ['artifact-text', workItemKey, artifact.revisionId],
    queryFn: ({ signal }) => client.work.artifactText(workItemKey, artifact.revisionId, signal),
    retry: false,
  });
  return (
    <div>
      <Button variant="secondary" onClick={onClose}>
        Back to artifacts
      </Button>
      <h2>{artifact.path}</h2>
      <a href={artifact.href}>Download {artifact.path}</a>
      {query.isPending ? (
        <LoadingState label="Loading artifact" />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <article className={styles.markdown} aria-label={artifact.path}>
          <Markdown skipHtml>{query.data}</Markdown>
        </article>
      )}
    </div>
  );
}
