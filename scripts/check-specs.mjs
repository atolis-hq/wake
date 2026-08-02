import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const shaPattern = /^[0-9a-f]{7,40}$/;

function readAsOf(specPath) {
  const contents = readFileSync(specPath, 'utf8');
  const match = frontmatterPattern.exec(contents);
  if (match === null) return null;
  const asOfLine = match[1].split(/\r?\n/).find((line) => line.startsWith('asOf:'));
  if (asOfLine === undefined) return null;
  const sha = asOfLine.slice('asOf:'.length).trim();
  return shaPattern.test(sha) ? sha : null;
}

function changedFiles(moduleDir, sha) {
  const output = execFileSync('git', ['diff', '--name-only', sha, '--', moduleDir], {
    cwd: root,
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith('.md'));
}

function shaExists(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const srcNextRoot = resolve(root, 'src-next');
const specPaths = readdirSync(srcNextRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `src-next/${entry.name}/SPEC.md`)
  .filter((relativePath) => existsSync(resolve(root, relativePath)))
  .sort();
if (specPaths.length === 0) {
  console.error('No module SPEC.md files found under src-next/*/SPEC.md');
  process.exitCode = 1;
} else {
  const stale = [];
  const unchecked = [];
  const current = [];

  for (const relativePath of specPaths) {
    const specPath = resolve(root, relativePath);
    const moduleDir = dirname(relativePath);
    const asOf = readAsOf(specPath);

    if (asOf === null) {
      unchecked.push({ moduleDir, reason: 'no `asOf` frontmatter' });
      continue;
    }
    if (!shaExists(asOf)) {
      unchecked.push({ moduleDir, reason: `asOf ${asOf} is not a commit in this repo` });
      continue;
    }

    const changed = changedFiles(moduleDir, asOf);
    if (changed.length === 0) {
      current.push(moduleDir);
    } else {
      stale.push({ moduleDir, asOf, changed });
    }
  }

  if (stale.length > 0) {
    console.log('Stale (source changed since the spec was last synced):');
    for (const { moduleDir, asOf, changed } of stale) {
      console.log(`- ${moduleDir} (asOf ${asOf.slice(0, 12)}, ${changed.length} file(s) changed)`);
      for (const file of changed) console.log(`    ${file}`);
    }
  }
  if (unchecked.length > 0) {
    console.log('Unchecked (no valid checkpoint):');
    for (const { moduleDir, reason } of unchecked) console.log(`- ${moduleDir}: ${reason}`);
  }
  if (current.length > 0) {
    console.log(`Current: ${current.join(', ')}`);
  }

  if (stale.length > 0 || unchecked.length > 0) {
    console.error(
      `\n${stale.length} stale, ${unchecked.length} unchecked, ${current.length} current — run the sync-module-specs skill.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${current.length} module specs are current.`);
  }
}
