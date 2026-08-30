import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const hostNames = new Set(['EventProcessorHost']);
const registryNames = new Set(['EventProcessorRuntime']);
const serialiserNames = new Set([
  'createInMemoryProcessorRunSerialiser',
  'createFileProcessorRunSerialiser',
]);
const processorFactoryNames = new Set([
  'defineEventProcessor',
  'defineBatchEventProcessor',
  'createBatchEventProcessor',
  'createProjectionProcessor',
]);
const handlerPropertyNames = new Set(['handle', 'handler']);

/**
 * Enforce processor ownership through TypeScript symbols. The checker follows
 * imports, namespace members, and local assignment aliases, so local names
 * that merely resemble Wake runtime symbols remain valid.
 */
export async function checkEventProcessorArchitecture(root = 'src') {
  const resolvedRoot = resolve(root);
  const sourceRoot = (await directoryExists(join(resolvedRoot, 'src')))
    ? join(resolvedRoot, 'src')
    : resolvedRoot;
  const files = await typescriptFiles(sourceRoot);
  const program = ts.createProgram(files, {
    allowJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const typeChecker = program.getTypeChecker();
  const diagnostics = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) continue;
    const relativePath = relative(sourceRoot, file).split(sep).join('/');
    const moduleName = relativePath.split('/')[0];
    const bindings = collectBindings(sourceFile, typeChecker, sourceRoot);
    inspectRuntimeConstruction(
      sourceFile,
      bindings,
      typeChecker,
      sourceRoot,
      moduleName,
      relativePath,
      diagnostics,
    );
    if (moduleName === 'persistence') {
      inspectPersistenceProcessors(
        sourceFile,
        bindings,
        typeChecker,
        sourceRoot,
        relativePath,
        diagnostics,
      );
    }
  }

  return diagnostics;
}

function collectBindings(sourceFile, typeChecker, sourceRoot) {
  const assignments = new Map();
  const stringConstants = new Map();

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const symbol = typeChecker.getSymbolAtLocation(node.name);
      if (symbol !== undefined && node.initializer !== undefined)
        assignments.set(symbol, node.initializer);
      const value = staticString(node.initializer);
      if (value !== undefined) stringConstants.set(node.name.text, value);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = typeChecker.getSymbolAtLocation(node.left);
      if (symbol !== undefined) assignments.set(symbol, node.right);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { assignments, stringConstants, sourceRoot };
}

function inspectRuntimeConstruction(
  sourceFile,
  bindings,
  typeChecker,
  sourceRoot,
  moduleName,
  relativePath,
  diagnostics,
) {
  function visit(node) {
    if (ts.isNewExpression(node)) {
      const kind = resolveProtectedKind(node.expression, bindings, typeChecker, sourceRoot);
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
      const kind = resolveProtectedKind(node.expression, bindings, typeChecker, sourceRoot);
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

function inspectPersistenceProcessors(
  sourceFile,
  bindings,
  typeChecker,
  sourceRoot,
  relativePath,
  diagnostics,
) {
  const reported = new Set();
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const kind = resolveProtectedKind(node.expression, bindings, typeChecker, sourceRoot);
      if (kind === 'processor-factory') {
        addPersistenceDiagnostic(sourceFile, node, relativePath, diagnostics, reported);
        for (const argument of node.arguments)
          inspectLinkedHandlerProperties(
            argument,
            bindings,
            typeChecker,
            sourceRoot,
            sourceFile,
            relativePath,
            diagnostics,
            reported,
            new Set(),
          );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function inspectLinkedHandlerProperties(
  node,
  bindings,
  typeChecker,
  sourceRoot,
  sourceFile,
  relativePath,
  diagnostics,
  reported,
  seen,
) {
  if (seen.has(node)) return;
  seen.add(node);
  if (ts.isParenthesizedExpression(node)) {
    inspectLinkedHandlerProperties(
      node.expression,
      bindings,
      typeChecker,
      sourceRoot,
      sourceFile,
      relativePath,
      diagnostics,
      reported,
      seen,
    );
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (handlerPropertyNames.has(propertyName(property.name, bindings.stringConstants)))
        addPersistenceDiagnostic(sourceFile, property, relativePath, diagnostics, reported);
    }
    return;
  }
  if (ts.isIdentifier(node)) {
    const symbol = typeChecker.getSymbolAtLocation(node);
    const initializer = symbol === undefined ? undefined : bindings.assignments.get(symbol);
    if (initializer !== undefined)
      inspectLinkedHandlerProperties(
        initializer,
        bindings,
        typeChecker,
        sourceRoot,
        sourceFile,
        relativePath,
        diagnostics,
        reported,
        seen,
      );
    return;
  }
  if (ts.isCallExpression(node)) {
    const symbol = typeChecker.getSymbolAtLocation(node.expression);
    const declaration = localFactoryDeclaration(symbol, typeChecker, sourceRoot);
    if (declaration !== undefined)
      inspectLinkedHandlerProperties(
        declaration,
        bindings,
        typeChecker,
        sourceRoot,
        sourceFile,
        relativePath,
        diagnostics,
        reported,
        seen,
      );
    return;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
    const body = node.body;
    if (body !== undefined && ts.isExpression(body))
      inspectLinkedHandlerProperties(
        body,
        bindings,
        typeChecker,
        sourceRoot,
        sourceFile,
        relativePath,
        diagnostics,
        reported,
        seen,
      );
    else if (body !== undefined)
      for (const statement of body.statements)
        if (ts.isReturnStatement(statement) && statement.expression !== undefined)
          inspectLinkedHandlerProperties(
            statement.expression,
            bindings,
            typeChecker,
            sourceRoot,
            sourceFile,
            relativePath,
            diagnostics,
            reported,
            seen,
          );
  }
}

function resolveProtectedKind(expression, bindings, typeChecker, sourceRoot, seen = new Set()) {
  const symbol = typeChecker.getSymbolAtLocation(expression);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const resolved = resolveSymbol(symbol, typeChecker, sourceRoot);
  const kind = symbolKind(resolved, sourceRoot);
  if (kind !== undefined) return kind;
  const assignment = bindings.assignments.get(symbol);
  return assignment === undefined
    ? undefined
    : resolveProtectedKind(assignment, bindings, typeChecker, sourceRoot, seen);
}

function resolveSymbol(symbol, typeChecker, sourceRoot, seen = new Set()) {
  if (symbol === undefined || seen.has(symbol)) return symbol;
  seen.add(symbol);
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0)
    return resolveSymbol(typeChecker.getAliasedSymbol(symbol), typeChecker, sourceRoot, seen);
  return symbol;
}

function symbolKind(symbol, sourceRoot) {
  if (symbol === undefined) return undefined;
  for (const declaration of symbol.declarations ?? []) {
    const path = normalizeSourcePath(declaration.getSourceFile().fileName, sourceRoot);
    const name = symbol.name;
    if (pathMatches(path, 'eventing/application/event-processor-host.ts') && hostNames.has(name))
      return 'host';
    if (pathMatches(path, 'bootstrap/event-processor-runtime.ts') && registryNames.has(name))
      return 'registry';
    if (
      pathMatches(path, 'persistence/application/processor-run-serialiser.ts') &&
      serialiserNames.has(name)
    )
      return 'serialiser';
    if (
      pathMatches(path, 'eventing/contracts/event-processor.ts') &&
      processorFactoryNames.has(name)
    )
      return 'processor-factory';
    if (
      pathMatches(path, 'eventing/application/projection-processor.ts') &&
      processorFactoryNames.has(name)
    )
      return 'processor-factory';
  }
  return undefined;
}

function pathMatches(path, suffix) {
  return path === suffix || path.endsWith(`/${suffix}`);
}

function localFactoryDeclaration(symbol, typeChecker, sourceRoot) {
  const resolved = resolveSymbol(symbol, typeChecker, sourceRoot);
  for (const declaration of resolved?.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined)
      return declaration.initializer;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
  }
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

function staticString(node) {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function addPersistenceDiagnostic(sourceFile, node, relativePath, diagnostics, reported) {
  const key = node.getStart(sourceFile);
  if (reported.has(key)) return;
  reported.add(key);
  addDiagnostic(
    sourceFile,
    node,
    relativePath,
    'persistence-processor-handler',
    'persistence may not define handlers for Eventing processors',
    diagnostics,
  );
}

function addDiagnostic(sourceFile, node, relativePath, rule, detail, diagnostics) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  diagnostics.push({ message: `${relativePath}:${line + 1}:${character + 1} [${rule}] ${detail}` });
}

function normalizeSourcePath(fileName, sourceRoot) {
  const absolute = isAbsolute(fileName) ? fileName : resolve(fileName);
  return relative(sourceRoot, absolute).split(sep).join('/');
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
