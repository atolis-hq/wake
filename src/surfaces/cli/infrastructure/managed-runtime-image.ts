import { fileURLToPath } from 'node:url';

export const managedRuntimeImage = 'wake-sandbox-runtime:managed';

export function managedRuntimeDockerfile(packaged: boolean): string {
  const packageRoot = packaged ? '../../../../../' : '../../../../';
  return fileURLToPath(
    new URL(
      `${packageRoot}docker/Dockerfile.runtime${packaged ? '.packaged' : ''}`,
      import.meta.url,
    ),
  );
}
