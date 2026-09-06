import { fileURLToPath } from 'node:url';

export const managedRuntimeImage = 'wake-sandbox-runtime:managed';

export function managedRuntimeDockerfile(packaged: boolean): string {
  return fileURLToPath(
    new URL(`../../../../docker/Dockerfile.runtime${packaged ? '.packaged' : ''}`, import.meta.url),
  );
}
