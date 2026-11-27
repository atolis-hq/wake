import { dirname, normalize } from 'node:path/posix';

export function sandboxHomeInitDirectories(
  containerHomeMountPath: string | undefined,
  extraMounts: readonly { readonly target: string }[],
): readonly string[] {
  if (containerHomeMountPath === undefined) return [];
  const home = normalize(containerHomeMountPath);
  const prefix = home === '/' ? '/' : `${home}/`;
  const directories = new Set<string>();
  for (const mount of extraMounts) {
    let current = dirname(normalize(mount.target));
    while (current !== home && current.startsWith(prefix)) {
      directories.add(current);
      current = dirname(current);
    }
  }
  return [...directories].sort();
}
