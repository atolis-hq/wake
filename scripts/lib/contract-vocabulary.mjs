import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { discoverCatalogues } from './contract-vocabulary-catalogues.mjs';
import {
  compareCodeUnits,
  evaluateVocabulary,
  sortDiagnostics,
} from './contract-vocabulary-rules.mjs';
import { deriveProviders, evaluateProviderLocality } from './provider-locality-rule.mjs';

export const CONTRACT_VOCABULARY_RULES = [
  'closed-vocabulary',
  'event-literals',
  'stream-literals',
  'provider-locality',
];

const allRules = new Set(CONTRACT_VOCABULARY_RULES);

export async function checkContractVocabulary(root, options = {}) {
  const rules = selectRules(options.rules);
  const { scanRoot, displayRoot } = await roots(root);
  const paths = await typeScriptFiles(scanRoot);
  const sourceDetails = await Promise.all(
    paths.map(async (path) => {
      const text = await readFile(path, 'utf8');
      return {
        path: normalizePath(relative(displayRoot, path)),
        source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      };
    }),
  );
  const discovery = discoverCatalogues(sourceDetails, rules);
  const diagnostics = [...discovery.diagnostics];

  for (const detail of sourceDetails) {
    diagnostics.push(...evaluateVocabulary(detail, discovery.catalogues, rules));
  }

  if (rules.has('provider-locality')) {
    const providers = await deriveProviders(resolve(scanRoot, 'integrations'));
    for (const detail of sourceDetails) {
      diagnostics.push(...evaluateProviderLocality(detail, providers));
    }
  }

  return sortDiagnostics(diagnostics);
}

function selectRules(requested) {
  if (requested === undefined) return allRules;
  if (requested.length === 0) {
    throw new Error('Contract vocabulary rules must not be empty');
  }
  const selected = new Set(requested);
  const unknown = [...selected].filter((rule) => !allRules.has(rule));
  if (unknown.length > 0) {
    throw new Error(`Unknown contract-vocabulary rule: ${unknown.join(', ')}`);
  }
  return selected;
}

async function roots(root) {
  const requestedRoot = resolve(root);
  if (basename(requestedRoot).toLowerCase() === 'src') {
    return { scanRoot: requestedRoot, displayRoot: dirname(requestedRoot) };
  }
  const nestedSourceRoot = resolve(requestedRoot, 'src');
  if (await isDirectory(nestedSourceRoot)) {
    return { scanRoot: nestedSourceRoot, displayRoot: requestedRoot };
  }
  return { scanRoot: requestedRoot, displayRoot: requestedRoot };
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function typeScriptFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return typeScriptFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat().sort(compareCodeUnits);
}

function normalizePath(path) {
  return path.split(sep).join('/');
}
