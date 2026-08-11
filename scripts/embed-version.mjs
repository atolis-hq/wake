#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionModulePath = resolve(repoRoot, 'dist/src/bootstrap/version.js');
const { resolveWakeVersion } = await import('../dist/src/bootstrap/version.js');

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

  return resolveWakeVersion({ repoRoot });
}

const buildVersion = resolveBuildVersion();
const source = readFileSync(versionModulePath, 'utf8');
const updated = source.replace(
  /export const wakeVersion = (?:['"][^'"]+['"]|resolveWakeVersion\(\));/,
  `export const wakeVersion = ${JSON.stringify(buildVersion)};`,
);

if (updated === source) {
  throw new Error(`Could not find wakeVersion export in ${versionModulePath}`);
}

writeFileSync(versionModulePath, updated);
console.log(`Embedded Wake version ${buildVersion} (src)`);
