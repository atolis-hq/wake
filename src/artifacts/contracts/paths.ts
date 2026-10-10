export type ArtifactPath = string & { readonly __artifactPath: unique symbol };

/** A logical path, never a path that can escape an artifact owner namespace. */
export function artifactPath(value: string): ArtifactPath {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  )
    throw new Error('Artifact path must be a normalized relative path');
  return value as ArtifactPath;
}
