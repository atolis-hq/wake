import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const hostNames = new Set(['EventProcessorHost']);
const registryNames = new Set(['EventProcessorRuntime']);
const serialiserNames = new Set([
  'createInMemoryProcessorRunSerialiser',
  'createFileProcessorRunSerialiser',
]);
const handlerNames = new Set(['handle', 'handler']);

/**
 * Enforce ownership at the binding and syntax level rather than by scanning
 * text. Type-only imports are not runtime construction, while aliases and
 * namespace imports still resolve to the protected runtime symbols.
 */
export async function checkEventProcessorArchitecture(root = 'src') {
  const resolvedRoot = resolve(root);
  const sourceRoot = (await directoryExists(join(resolvedRoot, 'src')))
    ? join(resolvedRoot, 'src')
    : resolvedRoot;
  const files = await typescriptFiles(sourceRoot);
  const diagnostics = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const relativePath = relative(sourceRoot, file).split(sep).join('/');
    const moduleName = relativePath.split('/')[0];
    const sourceFile = ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const bindings = collectBindings(sourceFile);
    inspectRuntimeConstruction(sourceFile, bindings, moduleName, relativePath, diagnostics);
    if (moduleName === 'persistence') {
      inspectPersistenceHandlers(sourceFile, bindings, relativePath, diagnostics);
    }
  }

  return diagnostics;
}

function collectBindings(sourceFile) {
  const bindings = new Map();
  const namespaces = new Map();
  const stringConstants = new Map();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const modulePath = statement.moduleSpecifier.text;
    if (clause.namedBindings === undefined) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.set(clause.namedBindings.name.text, modulePath);
      continue;
    }
    for (const specifier of clause.namedBindings.elements) {
      if (specifier.isTypeOnly) continue;
      const imported = (specifier.propertyName ?? specifier.name).text;
      const local = specifier.name.text;
      const kind =
        imported === 'defineEventProcessor' ? 'processor-factory' : protectedKind(imported);
      if (kind !== undefined) bindings.set(local, { kind, modulePath });
    }
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const value = staticString(node.initializer);
      if (value !== undefined) stringConstants.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { bindings, namespaces, stringConstants };
}

function inspectRuntimeConstruction(sourceFile, bindings, moduleName, relativePath, diagnostics) {
  function visit(node) {
    if (ts.isNewExpression(node)) {
      const kind = protectedKindForExpression(node.expression, bindings);
      if (kind === 'host' && !['eventing', 'bootstrap'].includes(moduleName))
        addDiagnostic(
          sourceFile,
          node,
          relativePath,
          'event-processor-host-owner',
          'EventProcessorHost may only be constructed by eventing or bootstrap',
          diagnostics,
        );
      if (kind === 'registry' && moduleName !== 'bootstrap')
        addDiagnostic(
          sourceFile,
          node,
          relativePath,
          'processor-registry-owner',
          'the complete EventProcessorRuntime may only be composed by bootstrap',
          diagnostics,
        );
    }
    if (ts.isCallExpression(node)) {
      const kind = protectedKindForExpression(node.expression, bindings);
      if (kind === 'serialiser' && !['persistence', 'bootstrap'].includes(moduleName))
        addDiagnostic(
          sourceFile,
          node,
          relativePath,
          'processor-serialiser-owner',
          'concrete processor serialisers may only be constructed by persistence or bootstrap',
          diagnostics,
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function inspectPersistenceHandlers(sourceFile, bindings, relativePath, diagnostics) {
  const stringConstants = bindings.stringConstants;
  function visit(node) {
    if (ts.isCallExpression(node) && isProcessorFactory(node.expression, bindings)) {
      addDiagnostic(
        sourceFile,
        node,
        relativePath,
        'persistence-processor-handler',
        'persistence may not define processor handlers',
        diagnostics,
      );
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      declarationDefinesHandler(node)
    ) {
      addDiagnostic(
        sourceFile,
        node,
        relativePath,
        'persistence-processor-handler',
        'persistence may not define processor handlers',
        diagnostics,
      );
    }
    if (ts.isExportSpecifier(node) && handlerNames.has(node.name.text)) {
      addDiagnostic(
        sourceFile,
        node,
        relativePath,
        'persistence-processor-handler',
        'persistence may not define processor handlers',
        diagnostics,
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const name = propertyName(property.name, stringConstants);
        if (name !== undefined && handlerNames.has(name)) {
          addDiagnostic(
            sourceFile,
            property,
            relativePath,
            'persistence-processor-handler',
            'persistence may not define processor handlers',
            diagnostics,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function protectedKindForExpression(expression, bindings) {
  if (ts.isIdentifier(expression)) {
    const imported = bindings.bindings.get(expression.text);
    if (imported !== undefined) return imported.kind;
    return protectedKind(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const modulePath = bindings.namespaces.get(expression.expression.text);
    if (modulePath !== undefined) return protectedKind(expression.name.text);
  }
  return undefined;
}

function protectedKind(name) {
  if (hostNames.has(name)) return 'host';
  if (registryNames.has(name)) return 'registry';
  if (serialiserNames.has(name)) return 'serialiser';
  return undefined;
}

function staticString(node) {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function propertyName(name, stringConstants) {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  if (ts.isComputedPropertyName(name)) {
    if (ts.isIdentifier(name.expression)) return stringConstants.get(name.expression.text);
    return staticString(name.expression);
  }
  return undefined;
}

function declarationDefinesHandler(node) {
  if (node.name === undefined || !ts.isIdentifier(node.name)) return false;
  return /handler/i.test(node.name.text);
}

function isProcessorFactory(expression, bindings) {
  if (ts.isIdentifier(expression))
    return (
      expression.text === 'defineEventProcessor' ||
      bindings.bindings.get(expression.text)?.kind === 'processor-factory'
    );
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text) &&
    expression.name.text === 'defineEventProcessor'
  );
}

function addDiagnostic(sourceFile, node, relativePath, rule, detail, diagnostics) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  diagnostics.push({ message: `${relativePath}:${line + 1}:${character + 1} [${rule}] ${detail}` });
}

async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

async function directoryExists(path) {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const diagnostics = await checkEventProcessorArchitecture();
  if (diagnostics.length > 0) {
    process.stderr.write(`${diagnostics.map(({ message }) => message).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Event processor architecture valid\n');
  }
}
