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

  it('publishes only Wake from the root package on tagged main after all checks', async () => {
    const workflow = await readRepositoryFile('.github/workflows/ci-cd.yml');
    const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));
    const versionSet = publishJob.indexOf('npm pkg set version="$WAKE_VERSION"');
    const archiveCheck = publishJob.indexOf('run: npm run check:workspace-packages');
    const wakePublish = publishJob.indexOf(
      'npm publish --workspaces=false --access public --provenance',
    );

    expect(workflow).toContain('run: npm run verify');
    expect(workflow).toContain('run: npm run test:architecture');
    expect(workflow).toContain('run: npm run knip');
    expect(workflow).toContain('npm run check:workspace-packages');
    expect(workflow).toContain(
      'needs: [fast-verify, architecture, package-contract, knip, integration, e2e, web, docker-smoke]',
    );
    expect(workflow).toContain(
      "if: github.ref == 'refs/heads/main' && github.event_name == 'push'",
    );
    expect(workflow).toContain('WAKE_VERSION: ${{ needs.tag.outputs.version }}');
    expect(workflow).toContain('npm pkg set version="$WAKE_VERSION"');
    expect(publishJob).toContain('WAKE_BUILD_TAG: v${{ needs.tag.outputs.version }}');
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

    expect(versionSet).toBeGreaterThan(-1);
    expect(archiveCheck).toBeGreaterThan(-1);
    expect(wakePublish).toBeGreaterThan(-1);
    expect(versionSet).toBeLessThan(archiveCheck);
    expect(archiveCheck).toBeLessThan(wakePublish);
    expect(workflow).toContain('--access public --provenance');
  });
});
