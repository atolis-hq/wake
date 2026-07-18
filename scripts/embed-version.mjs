#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionModulePath = resolve(repoRoot, 'dist/src/version.js');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function resolveBuildVersion() {
  const explicitTag = process.env.WAKE_BUILD_TAG?.trim();
  if (explicitTag !== undefined && explicitTag.length > 0) {
    return explicitTag;
  }

  if (process.env.GITHUB_REF_TYPE === 'tag') {
    const refName = process.env.GITHUB_REF_NAME?.trim();
    if (refName !== undefined && refName.length > 0) {
      return refName;
    }
  }

  const exactTag = gitOutput(['describe', '--tags', '--exact-match', 'HEAD']);
  if (exactTag.length > 0) {
    return exactTag;
  }

  const shortHash = gitOutput(['rev-parse', '--short', 'HEAD']);
  if (shortHash.length > 0) {
    return `${packageJson.version}+g${shortHash}`;
  }

  return `${packageJson.version}-dev`;
}

const buildVersion = resolveBuildVersion();
const source = readFileSync(versionModulePath, 'utf8');
const updated = source.replace(
  /export const wakeVersion = ['"][^'"]+['"];/,
  `export const wakeVersion = ${JSON.stringify(buildVersion)};`,
);

if (updated === source) {
  throw new Error(`Could not find wakeVersion export in ${versionModulePath}`);
}

writeFileSync(versionModulePath, updated);
console.log(`Embedded Wake version ${buildVersion}`);
