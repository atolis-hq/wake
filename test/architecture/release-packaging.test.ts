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

  it('publishes the three public packages at one version in dependency order', async () => {
    const workflow = await readRepositoryFile('.github/workflows/ci-cd.yml');

    expect(workflow).toContain('run: npm run verify && npm run test:architecture && npm run knip');
    expect(workflow).toContain('npm run check:workspace-packages');
    expect(workflow).toContain('WAKE_VERSION: ${{ needs.tag.outputs.version }}');
    expect(workflow).toContain(
      'npm version "$WAKE_VERSION" --workspaces=false --no-git-tag-version --ignore-scripts',
    );
    expect(workflow).toContain(
      'npm --workspace @atolis-hq/eventing version "$WAKE_VERSION" --no-git-tag-version --ignore-scripts',
    );
    expect(workflow).toContain(
      'npm --workspace @atolis-hq/eventing-filesystem version "$WAKE_VERSION" --no-git-tag-version --ignore-scripts',
    );
    expect(workflow).toContain(
      'npm pkg set dependencies.@atolis-hq/eventing="$WAKE_VERSION" dependencies.@atolis-hq/eventing-filesystem="$WAKE_VERSION"',
    );
    expect(workflow).toContain(
      'npm --workspace @atolis-hq/eventing-filesystem pkg set dependencies.@atolis-hq/eventing="$WAKE_VERSION"',
    );
    expect(workflow).toContain('npm install --package-lock-only --ignore-scripts');
    expect(workflow).not.toMatch(/npm publish --workspaces(?:\s|$)/u);

    const eventingPublish = workflow.indexOf('npm --workspace @atolis-hq/eventing publish');
    const filesystemPublish = workflow.indexOf(
      'npm --workspace @atolis-hq/eventing-filesystem publish',
    );
    const wakePublish = workflow.indexOf(
      'npm publish --workspaces=false --access public --provenance',
    );

    expect(eventingPublish).toBeGreaterThan(-1);
    expect(filesystemPublish).toBeGreaterThan(eventingPublish);
    expect(wakePublish).toBeGreaterThan(filesystemPublish);
    expect(workflow).toContain('--access public --provenance');
  });
});
