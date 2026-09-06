import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const readRepositoryFile = (path: string): Promise<string> =>
  readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('release packaging', () => {
  it('uses the source workspace context only where a Docker image builds Wake', async () => {
    const [sourceDockerfile, packagedDockerfile] = await Promise.all([
      readRepositoryFile('docker/Dockerfile'),
      readRepositoryFile('docker/Dockerfile.packaged'),
    ]);

    expect(sourceDockerfile).toContain('COPY package*.json ./');
    expect(sourceDockerfile).toContain(
      'COPY packages/eventing/package.json packages/eventing/package.json',
    );
    expect(sourceDockerfile).toContain(
      'COPY packages/eventing-filesystem/package.json packages/eventing-filesystem/package.json',
    );
    expect(sourceDockerfile).toContain(
      'COPY src/surfaces/web/package.json src/surfaces/web/package.json',
    );
    expect(sourceDockerfile).toContain(
      'COPY tsconfig.json tsconfig.base.json tsconfig.app.json tsconfig.docker.json ./',
    );
    expect(sourceDockerfile).toContain('COPY packages/ packages/');
    expect(sourceDockerfile).toContain(
      'COPY scripts/embed-runtime-workspaces.mjs scripts/embed-runtime-workspaces.mjs',
    );
    expect(sourceDockerfile).toContain('COPY src/ src/');
    expect(sourceDockerfile.indexOf('COPY packages/eventing/package.json')).toBeLessThan(
      sourceDockerfile.indexOf('npm ci --include=dev'),
    );
    expect(sourceDockerfile.indexOf('COPY packages/ packages/')).toBeLessThan(
      sourceDockerfile.indexOf('npm run build:docker'),
    );

    expect(packagedDockerfile).toContain('ARG WAKE_VERSION');
    expect(packagedDockerfile).toContain('"@atolis-hq/wake@${WAKE_VERSION}"');
    expect(packagedDockerfile).not.toContain('npm ci');
  });

  it('publishes the verified Wake archive on tagged main after all checks', async () => {
    const workflow = await readRepositoryFile('.github/workflows/ci-cd.yml');
    const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));
    const packageJob = workflow.slice(workflow.indexOf('\n  package-contract:'));
    const archiveBuild = packageJob.indexOf(
      'npm pack --ignore-scripts --json --pack-destination artifacts',
    );
    const archiveCheck = packageJob.indexOf(
      'node scripts/check-workspace-packages.mjs --archive artifacts/*.tgz',
    );
    const artifactUpload = packageJob.indexOf('uses: actions/upload-artifact@v4');
    const artifactDownload = publishJob.indexOf('uses: actions/download-artifact@v5');
    const wakePublish = publishJob.indexOf(
      'npm publish ./artifacts/atolis-hq-wake-${{ needs.tag.outputs.version }}.tgz --workspaces=false --access public --provenance',
    );

    expect(workflow).toContain('run: npm run verify');
    expect(workflow).toContain('run: npm run test:architecture');
    expect(workflow).toContain('run: npm run knip');
    expect(workflow).toContain('release-version:');
    expect(workflow).toContain('release-version,');
    expect(workflow).toContain('package-contract,');
    expect(workflow).toContain('docker-smoke,');
    expect(workflow).toContain(
      "if: github.ref == 'refs/heads/main' && github.event_name == 'push'",
    );
    expect(workflow).toContain('WAKE_VERSION: ${{ needs.release-version.outputs.version }}');
    expect(workflow).toContain('npm pkg set version="$WAKE_VERSION"');
    expect(packageJob).toContain('WAKE_BUILD_TAG:');
    expect(workflow).not.toContain('npm version "$WAKE_VERSION"');
    expect(workflow).not.toMatch(/npm publish --workspaces(?:\s|$)/u);
    expect(workflow).not.toContain('npm install --package-lock-only --ignore-scripts');

    for (const forbidden of [
      'npm --workspace @atolis-hq/eventing pkg set version="$WAKE_VERSION"',
      'npm --workspace @atolis-hq/eventing-filesystem pkg set version="$WAKE_VERSION"',
      'npm --workspace @atolis-hq/eventing-filesystem pkg set version="$WAKE_VERSION" dependencies.@atolis-hq/eventing="$WAKE_VERSION"',
      'dependencies.@atolis-hq/eventing="$WAKE_VERSION"',
      'dependencies.@atolis-hq/eventing-filesystem="$WAKE_VERSION"',
      'npm --workspace @atolis-hq/eventing publish',
      'npm --workspace @atolis-hq/eventing-filesystem publish',
    ]) {
      expect(workflow).not.toContain(forbidden);
    }

    expect(archiveBuild).toBeGreaterThan(-1);
    expect(archiveCheck).toBeGreaterThan(-1);
    expect(artifactUpload).toBeGreaterThan(-1);
    expect(artifactDownload).toBeGreaterThan(-1);
    expect(wakePublish).toBeGreaterThan(-1);
    expect(archiveBuild).toBeLessThan(archiveCheck);
    expect(archiveCheck).toBeLessThan(artifactUpload);
    expect(artifactDownload).toBeLessThan(wakePublish);
    expect(workflow).toContain('--access public --provenance');
  });
});
