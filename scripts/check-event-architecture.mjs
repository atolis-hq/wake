import { readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
const publishingInfrastructureModules = new Set(['bootstrap', 'eventing', 'persistence']);
const legacyDraftNames = new Set([
  'EventDraft',
  'EventDraftUnion',
  'EventDraftInput',
  'createEventDraft',
  'eventDraftSchema',
]);
const eventDataPropertyNames = new Set([
  'eventId',
  'eventType',
  'schemaVersion',
  'occurredAt',
  'correlationId',
  'causationId',
  'actor',
  'source',
  'payload',
]);
const envelopePropertyNames = new Set([
  'event',
  'stream',
  'recordedAt',
  'sequence',
  'globalPosition',
]);

/**
 * Enforce event processor and publishing ownership through TypeScript symbols.
 * Imports, namespace members, re-exports, and local aliases resolve to their
 * declarations, leaving unrelated local symbols and dynamic properties alone.
 */
export async function checkEventArchitecture(root = 'src') {
  const resolvedRoot = resolve(root);
  const sourceRoot = (await directoryExists(join(resolvedRoot, 'src')))
    ? join(resolvedRoot, 'src')
    : resolvedRoot;
  const [files, manifests] = await Promise.all([
    typescriptFiles(sourceRoot),
    readEventNamespaceManifests(sourceRoot),
  ]);
  const program = ts.createProgram(files, {
    allowJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const typeChecker = program.getTypeChecker();
  const bindings = collectBindings(program, typeChecker);
  const canonicalSymbols = collectCanonicalSymbols(program, typeChecker, sourceRoot);
  const diagnostics = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) continue;
    const relativePath = normalizeSourcePath(file, sourceRoot);
    const moduleName = relativePath.split('/')[0];
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
    inspectPublishingOwnership({
      sourceFile,
      bindings,
      typeChecker,
      sourceRoot,
      moduleName,
      relativePath,
      manifests,
      canonicalSymbols,
      diagnostics,
    });
  }

  return diagnostics;
}

function collectBindings(program, typeChecker) {
  const assignments = new Map();

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) {
        const symbol = typeChecker.getSymbolAtLocation(node.name);
        if (symbol !== undefined) assignments.set(symbol, { expression: node.initializer });
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const name = bindingPropertyName(element);
          const symbol = typeChecker.getSymbolAtLocation(element.name);
          if (name !== undefined && symbol !== undefined)
            assignments.set(symbol, { expression: node.initializer, propertyName: name });
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = typeChecker.getSymbolAtLocation(node.left);
      if (symbol !== undefined) assignments.set(symbol, { expression: node.right });
    }
    ts.forEachChild(node, visit);
  }

  for (const sourceFile of program.getSourceFiles())
    if (!sourceFile.isDeclarationFile || normalizePath(sourceFile.fileName).includes('/src/'))
      visit(sourceFile);
  return { assignments };
}

function bindingPropertyName(element) {
  if (element.propertyName === undefined && ts.isIdentifier(element.name)) return element.name.text;
  if (element.propertyName !== undefined) return literalPropertyName(element.propertyName);
  return undefined;
}

function collectCanonicalSymbols(program, typeChecker, sourceRoot) {
  const symbols = new Map();

  function visit(node) {
    if ('name' in node && node.name !== undefined) {
      const symbol = typeChecker.getSymbolAtLocation(node.name);
      const kind = protectedSymbolKind(resolveSymbol(symbol, typeChecker), sourceRoot);
      if (kind !== undefined && !symbols.has(kind))
        symbols.set(kind, resolveSymbol(symbol, typeChecker));
    }
    ts.forEachChild(node, visit);
  }

  for (const sourceFile of program.getSourceFiles())
    if (!sourceFile.isDeclarationFile) visit(sourceFile);
  return symbols;
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
  const expression = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (handlerPropertyNames.has(propertyName(property.name, bindings, typeChecker)))
        addPersistenceDiagnostic(sourceFile, property, relativePath, diagnostics, reported);
    }
    return;
  }
  if (ts.isIdentifier(expression)) {
    const symbol = typeChecker.getSymbolAtLocation(expression);
    const assignment = symbol === undefined ? undefined : bindings.assignments.get(symbol);
    if (assignment !== undefined && assignment.propertyName === undefined)
      inspectLinkedHandlerProperties(
        assignment.expression,
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
  if (ts.isCallExpression(expression)) {
    const symbol = expressionSymbol(expression.expression, bindings, typeChecker);
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
  if (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isFunctionDeclaration(expression)
  ) {
    const body = expression.body;
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

function inspectPublishingOwnership(context) {
  const {
    sourceFile,
    bindings,
    typeChecker,
    sourceRoot,
    moduleName,
    relativePath,
    manifests,
    canonicalSymbols,
    diagnostics,
  } = context;

  inspectBoundedEventImports(context);

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const kind = resolveProtectedKind(node.expression, bindings, typeChecker, sourceRoot);
      if (
        kind === 'event-data-factory' &&
        !isApprovedEventDataFactoryPath(relativePath, moduleName, manifests)
      )
        addDiagnostic(
          sourceFile,
          node,
          relativePath,
          'event-data-factory-owner',
          'Kernel createEventData may only be called by an owning event factory or Kernel test helper',
          diagnostics,
        );
      if (isLegacyJournalAppendCall(node, bindings, typeChecker, sourceRoot))
        addDiagnostic(
          sourceFile,
          node,
          relativePath,
          'legacy-event-journal-append',
          'EventJournal.append is legacy; publish EventData with appendToStream',
          diagnostics,
        );
    }
    if (
      (ts.isMethodSignature(node) || ts.isPropertySignature(node)) &&
      literalPropertyName(node.name) === 'append' &&
      isEventJournalMember(node, typeChecker, sourceRoot)
    )
      addDiagnostic(
        sourceFile,
        node,
        relativePath,
        'legacy-event-journal-append',
        'EventJournal must not declare the legacy append method',
        diagnostics,
      );
    if (
      ts.isObjectLiteralExpression(node) &&
      isEventEnvelopeConstruction(node, typeChecker, sourceRoot, canonicalSymbols) &&
      !isApprovedEnvelopeConstructionPath(relativePath)
    )
      addDiagnostic(
        sourceFile,
        node,
        relativePath,
        'event-envelope-construction-owner',
        'journal envelope metadata may only be constructed by Persistence journal adapters',
        diagnostics,
      );
    if (
      ts.isObjectLiteralExpression(node) &&
      publishingInfrastructureModules.has(moduleName) &&
      isBoundedEventDataConstruction(node, typeChecker, sourceRoot, manifests, canonicalSymbols)
    )
      addDiagnostic(
        sourceFile,
        node,
        relativePath,
        'bounded-event-data-construction',
        'Bootstrap, Persistence, and Eventing must delegate bounded EventData construction to its owner',
        diagnostics,
      );
    if (ts.isIdentifier(node) && legacyDraftNames.has(node.text) && !isTestPath(relativePath))
      addDiagnostic(
        sourceFile,
        node,
        relativePath,
        'legacy-event-draft-symbol',
        `${node.text} is legacy production vocabulary; use EventData`,
        diagnostics,
      );
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function inspectBoundedEventImports(context) {
  const { sourceFile, typeChecker, sourceRoot, moduleName, relativePath, manifests, diagnostics } =
    context;
  if (!['eventing', 'persistence'].includes(moduleName)) return;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const bindings = importBindings(statement.importClause);
    for (const binding of bindings) {
      const symbol = typeChecker.getSymbolAtLocation(binding);
      if (!isBoundedEventContractSymbol(symbol, typeChecker, sourceRoot, manifests)) continue;
      addDiagnostic(
        sourceFile,
        binding,
        relativePath,
        'bounded-event-import-owner',
        'Persistence and Eventing may not import bounded event contracts',
        diagnostics,
      );
    }
  }
}

function importBindings(importClause) {
  const bindings = [];
  if (importClause.name !== undefined) bindings.push(importClause.name);
  const namedBindings = importClause.namedBindings;
  if (namedBindings === undefined) return bindings;
  if (ts.isNamespaceImport(namedBindings)) bindings.push(namedBindings.name);
  else for (const element of namedBindings.elements) bindings.push(element.name);
  return bindings;
}

function isBoundedEventContractSymbol(
  symbol,
  typeChecker,
  sourceRoot,
  manifests,
  seen = new Set(),
) {
  const resolved = resolveSymbol(symbol, typeChecker);
  if (resolved === undefined || seen.has(resolved)) return false;
  seen.add(resolved);
  if (boundedEventOwnerForSymbol(resolved, sourceRoot, manifests) !== undefined) return true;
  if ((resolved.flags & ts.SymbolFlags.Module) === 0) return false;
  return typeChecker
    .getExportsOfModule(resolved)
    .some((exported) =>
      isBoundedEventContractSymbol(exported, typeChecker, sourceRoot, manifests, seen),
    );
}

function boundedEventOwnerForSymbol(symbol, sourceRoot, manifests) {
  for (const declaration of symbol?.declarations ?? []) {
    const path = normalizeSourcePath(declaration.getSourceFile().fileName, sourceRoot);
    const owner = path.split('/')[0];
    if ((manifests.get(owner)?.length ?? 0) === 0) continue;
    if (isEventContractPath(path)) return owner;
  }
  return undefined;
}

function isEventContractPath(path) {
  const file = basename(path);
  return (
    file === 'events.ts' ||
    file.endsWith('-events.ts') ||
    file === 'intents.ts' ||
    file === 'event-factory.ts' ||
    file.endsWith('-event-factory.ts')
  );
}

function isApprovedEventDataFactoryPath(relativePath, moduleName, manifests) {
  if (isKernelTestPath(relativePath) || pathMatches(relativePath, 'test/support/event-envelope.ts'))
    return true;
  if ((manifests.get(moduleName)?.length ?? 0) === 0) return false;
  return /\/contracts\/[^/]*event-factory\.ts$/u.test(relativePath);
}

function isApprovedEnvelopeConstructionPath(relativePath) {
  if (pathMatches(relativePath, 'test/support/event-envelope.ts')) return true;
  return (
    /^persistence\/(?:filesystem|memory)\/[^/]*event-journal\.ts$/u.test(relativePath) ||
    pathMatches(relativePath, 'persistence/filesystem/event-record-codec.ts')
  );
}

function isKernelTestPath(relativePath) {
  return (
    /^test\/unit\/kernel\/.*\.test\.ts$/u.test(relativePath) ||
    /^unit\/kernel\/.*\.test\.ts$/u.test(relativePath)
  );
}

function isTestPath(relativePath) {
  return (
    relativePath.startsWith('test/') ||
    relativePath.includes('/test/') ||
    relativePath.endsWith('.test.ts')
  );
}

function isEventEnvelopeConstruction(node, typeChecker, sourceRoot, canonicalSymbols) {
  const contextualType = typeChecker.getContextualType(node);
  if (typeContainsProtectedKind(contextualType, 'event-envelope', typeChecker, sourceRoot))
    return true;
  if (!hasObjectProperties(node, envelopePropertyNames, typeChecker)) return false;
  const envelopeSymbol = canonicalSymbols.get('event-envelope');
  if (envelopeSymbol === undefined) return false;
  const envelopeType = typeChecker.getDeclaredTypeOfSymbol(envelopeSymbol);
  return typeChecker.isTypeAssignableTo(typeChecker.getTypeAtLocation(node), envelopeType);
}

function isBoundedEventDataConstruction(
  node,
  typeChecker,
  sourceRoot,
  manifests,
  canonicalSymbols,
) {
  const eventDataSymbol = canonicalSymbols.get('event-data');
  if (eventDataSymbol === undefined) return false;
  const eventDataType = typeChecker.getDeclaredTypeOfSymbol(eventDataSymbol);
  if (!typeChecker.isTypeAssignableTo(typeChecker.getTypeAtLocation(node), eventDataType))
    return false;
  const contextualType = typeChecker.getContextualType(node);
  if (
    typeContainsProtectedKind(contextualType, 'event-data', typeChecker, sourceRoot) &&
    boundedEventOwnerForType(contextualType, typeChecker, sourceRoot, manifests) !== undefined
  )
    return true;
  if (!hasObjectProperties(node, eventDataPropertyNames, typeChecker)) return false;
  const eventType = objectLiteralStringProperty(node, 'eventType', typeChecker);
  return eventType !== undefined && ownerForEventType(eventType, manifests) !== undefined;
}

function boundedEventOwnerForType(type, typeChecker, sourceRoot, manifests, seen = new Set()) {
  if (type === undefined || seen.has(type)) return undefined;
  seen.add(type);
  for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
    const owner = boundedEventOwnerForSymbol(
      resolveSymbol(symbol, typeChecker),
      sourceRoot,
      manifests,
    );
    if (owner !== undefined) return owner;
  }
  if (type.isUnionOrIntersection())
    for (const member of type.types) {
      const owner = boundedEventOwnerForType(member, typeChecker, sourceRoot, manifests, seen);
      if (owner !== undefined) return owner;
    }
  return undefined;
}

function ownerForEventType(eventType, manifests) {
  for (const [moduleName, namespaces] of manifests)
    if (namespaces.some((namespace) => eventType.startsWith(namespace))) return moduleName;
  return undefined;
}

function typeContainsProtectedKind(type, kind, typeChecker, sourceRoot, seen = new Set()) {
  if (type === undefined || seen.has(type)) return false;
  seen.add(type);
  for (const symbol of [type.aliasSymbol, type.getSymbol()])
    if (protectedSymbolKind(resolveSymbol(symbol, typeChecker), sourceRoot) === kind) return true;
  if (type.isUnionOrIntersection())
    return type.types.some((member) =>
      typeContainsProtectedKind(member, kind, typeChecker, sourceRoot, seen),
    );
  return false;
}

function hasObjectProperties(node, expected, typeChecker) {
  const names = new Set();
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) continue;
    const name = propertyName(property.name, { assignments: new Map() }, typeChecker);
    if (name !== undefined) names.add(name);
  }
  return [...expected].every((name) => names.has(name));
}

function objectLiteralStringProperty(node, expectedName, typeChecker) {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (literalPropertyName(property.name) !== expectedName) continue;
    const value = staticString(property.initializer, { assignments: new Map() }, typeChecker);
    if (value !== undefined) return value;
    const type = typeChecker.getTypeAtLocation(property.initializer);
    if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) return type.value;
  }
  return undefined;
}

function isLegacyJournalAppendCall(node, bindings, typeChecker, sourceRoot) {
  const expression = unwrapExpression(node.expression);
  let receiver;
  let name;
  if (ts.isPropertyAccessExpression(expression)) {
    receiver = expression.expression;
    name = expression.name.text;
  } else if (ts.isElementAccessExpression(expression)) {
    receiver = expression.expression;
    name = staticString(expression.argumentExpression, bindings, typeChecker);
  }
  if (receiver === undefined || name !== 'append') return false;
  const member = expressionSymbol(expression, bindings, typeChecker);
  if (isEventJournalMemberSymbol(member, typeChecker, sourceRoot)) return true;
  return typeContainsProtectedKind(
    typeChecker.getTypeAtLocation(receiver),
    'event-journal',
    typeChecker,
    sourceRoot,
  );
}

function isEventJournalMember(node, typeChecker, sourceRoot) {
  const symbol = typeChecker.getSymbolAtLocation(node.name);
  return isEventJournalMemberSymbol(symbol, typeChecker, sourceRoot);
}

function isEventJournalMemberSymbol(symbol, typeChecker, sourceRoot) {
  const resolved = resolveSymbol(symbol, typeChecker);
  for (const declaration of resolved?.declarations ?? []) {
    const parent = declaration.parent;
    if (!ts.isInterfaceDeclaration(parent)) continue;
    const owner = typeChecker.getSymbolAtLocation(parent.name);
    if (protectedSymbolKind(resolveSymbol(owner, typeChecker), sourceRoot) === 'event-journal')
      return true;
  }
  return false;
}

function resolveProtectedKind(expression, bindings, typeChecker, sourceRoot, seen = new Set()) {
  const unwrapped = unwrapExpression(expression);
  const symbol = expressionSymbol(unwrapped, bindings, typeChecker);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const resolved = resolveSymbol(symbol, typeChecker);
  const kind = protectedSymbolKind(resolved, sourceRoot);
  if (kind !== undefined) return kind;
  const assignment = bindings.assignments.get(symbol) ?? bindings.assignments.get(resolved);
  if (assignment === undefined) return undefined;
  if (assignment.propertyName !== undefined)
    return resolvePropertyKind(
      assignment.expression,
      assignment.propertyName,
      bindings,
      typeChecker,
      sourceRoot,
      seen,
    );
  return resolveProtectedKind(assignment.expression, bindings, typeChecker, sourceRoot, seen);
}

function resolvePropertyKind(receiver, propertyName, bindings, typeChecker, sourceRoot, seen) {
  const type = typeChecker.getTypeAtLocation(receiver);
  const symbol = type.getProperty(propertyName);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const resolved = resolveSymbol(symbol, typeChecker);
  const kind = protectedSymbolKind(resolved, sourceRoot);
  if (kind !== undefined) return kind;
  const assignment = bindings.assignments.get(symbol) ?? bindings.assignments.get(resolved);
  return assignment === undefined
    ? undefined
    : resolveProtectedKind(assignment.expression, bindings, typeChecker, sourceRoot, seen);
}

function expressionSymbol(expression, bindings, typeChecker) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped))
    return (
      typeChecker.getSymbolAtLocation(unwrapped.name) ?? typeChecker.getSymbolAtLocation(unwrapped)
    );
  if (ts.isElementAccessExpression(unwrapped)) {
    const name = staticString(unwrapped.argumentExpression, bindings, typeChecker);
    if (name === undefined) return undefined;
    return (
      typeChecker.getSymbolAtLocation(unwrapped) ??
      typeChecker.getTypeAtLocation(unwrapped.expression).getProperty(name)
    );
  }
  return typeChecker.getSymbolAtLocation(unwrapped);
}

function unwrapExpression(node) {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

function resolveSymbol(symbol, typeChecker, seen = new Set()) {
  if (symbol === undefined || seen.has(symbol)) return symbol;
  seen.add(symbol);
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0)
    return resolveSymbol(typeChecker.getAliasedSymbol(symbol), typeChecker, seen);
  return symbol;
}

function protectedSymbolKind(symbol, sourceRoot) {
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
    if (pathMatches(path, 'kernel/domain/event-envelope.ts') && name === 'createEventData')
      return 'event-data-factory';
    if (pathMatches(path, 'kernel/contracts/events.ts') && name === 'EventData')
      return 'event-data';
    if (pathMatches(path, 'kernel/contracts/events.ts') && name === 'EventEnvelope')
      return 'event-envelope';
    if (pathMatches(path, 'kernel/contracts/event-journal.ts') && name === 'EventJournal')
      return 'event-journal';
  }
  return undefined;
}

function pathMatches(path, suffix) {
  return path === suffix || path.endsWith(`/${suffix}`);
}

function localFactoryDeclaration(symbol, typeChecker, sourceRoot) {
  const resolved = resolveSymbol(symbol, typeChecker);
  for (const declaration of resolved?.declarations ?? []) {
    const path = normalizeSourcePath(declaration.getSourceFile().fileName, sourceRoot);
    if (path.startsWith('../')) continue;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined)
      return declaration.initializer;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
  }
  return undefined;
}

function propertyName(name, bindings, typeChecker) {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  if (ts.isComputedPropertyName(name)) return staticString(name.expression, bindings, typeChecker);
  return undefined;
}

function literalPropertyName(name) {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
      return expression.text;
  }
  return undefined;
}

function staticString(node, bindings, typeChecker, seen = new Set()) {
  if (node === undefined) return undefined;
  const expression = unwrapExpression(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return expression.text;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = typeChecker.getSymbolAtLocation(expression);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const assignment = bindings.assignments.get(symbol);
  return assignment?.propertyName === undefined
    ? staticString(assignment?.expression, bindings, typeChecker, seen)
    : undefined;
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
  return normalizePath(relative(sourceRoot, absolute));
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

async function readEventNamespaceManifests(sourceRoot) {
  const manifests = new Map();
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const input = JSON.parse(
            await readFile(join(sourceRoot, entry.name, 'module.json'), 'utf8'),
          );
          const events = input?.namespaces?.events;
          manifests.set(
            entry.name,
            Array.isArray(events) ? events.filter((value) => typeof value === 'string') : [],
          );
        } catch {
          manifests.set(entry.name, []);
        }
      }),
  );
  return manifests;
}

async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
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
  const diagnostics = await checkEventArchitecture();
  if (diagnostics.length > 0) {
    process.stderr.write(`${diagnostics.map(({ message }) => message).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Event architecture valid\n');
  }
}
