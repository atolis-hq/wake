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
  const bindings = { assignments };

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      collectBindingAssignments(
        node.name,
        node.initializer,
        [],
        bindings,
        typeChecker,
        assignments,
      );
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      collectAssignmentTarget(node.left, node.right, [], bindings, typeChecker, assignments);
    ts.forEachChild(node, visit);
  }

  for (const sourceFile of program.getSourceFiles())
    if (!sourceFile.isDeclarationFile || normalizePath(sourceFile.fileName).includes('/src/'))
      visit(sourceFile);
  return bindings;
}

function collectBindingAssignments(
  pattern,
  expression,
  accessPath,
  bindings,
  typeChecker,
  assignments,
) {
  if (ts.isIdentifier(pattern)) {
    const symbol = typeChecker.getSymbolAtLocation(pattern);
    if (symbol !== undefined) assignments.set(symbol, { expression, accessPath });
    return;
  }
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken !== undefined) continue;
      const name = bindingPropertyName(element, bindings, typeChecker);
      if (name === undefined) continue;
      collectBindingAssignments(
        element.name,
        expression,
        [...accessPath, { kind: 'property', name }],
        bindings,
        typeChecker,
        assignments,
      );
    }
    return;
  }
  if (ts.isArrayBindingPattern(pattern))
    for (const [index, element] of pattern.elements.entries()) {
      if (!ts.isBindingElement(element) || element.dotDotDotToken !== undefined) continue;
      collectBindingAssignments(
        element.name,
        expression,
        [...accessPath, { kind: 'index', index }],
        bindings,
        typeChecker,
        assignments,
      );
    }
}

function collectAssignmentTarget(
  target,
  expression,
  accessPath,
  bindings,
  typeChecker,
  assignments,
) {
  const unwrapped = unwrapExpression(target);
  if (ts.isIdentifier(unwrapped)) {
    const symbol = typeChecker.getSymbolAtLocation(unwrapped);
    if (symbol !== undefined) assignments.set(symbol, { expression, accessPath });
    return;
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    for (const [index, element] of unwrapped.elements.entries()) {
      if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) continue;
      collectAssignmentTarget(
        element,
        expression,
        [...accessPath, { kind: 'index', index }],
        bindings,
        typeChecker,
        assignments,
      );
    }
    return;
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) return;
  for (const property of unwrapped.properties) {
    if (ts.isSpreadAssignment(property)) continue;
    const name = propertyName(property.name, bindings, typeChecker);
    if (name === undefined) continue;
    const propertyTarget = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : ts.isPropertyAssignment(property)
        ? property.initializer
        : undefined;
    if (propertyTarget !== undefined)
      collectAssignmentTarget(
        propertyTarget,
        expression,
        [...accessPath, { kind: 'property', name }],
        bindings,
        typeChecker,
        assignments,
      );
  }
}

function bindingPropertyName(element, bindings, typeChecker) {
  if (element.propertyName === undefined && ts.isIdentifier(element.name)) return element.name.text;
  if (element.propertyName !== undefined)
    return propertyName(element.propertyName, bindings, typeChecker);
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
    if (assignment !== undefined && assignment.accessPath.length === 0)
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
  const { sourceFile, typeChecker, moduleName } = context;
  if (!['eventing', 'persistence'].includes(moduleName)) return;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause !== undefined)
      for (const binding of importBindings(statement.importClause))
        addBoundedEventReferenceDiagnostic(binding, binding, context);
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined)
      inspectBoundedEventExport(statement, context);
  }
  function visit(node) {
    if (ts.isImportTypeNode(node)) {
      const target =
        node.qualifier ??
        (ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
      addBoundedEventReferenceDiagnostic(target, importTypeSymbol(node, typeChecker), context);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function inspectBoundedEventExport(node, context) {
  const { typeChecker } = context;
  if (node.exportClause === undefined) {
    addBoundedEventReferenceDiagnostic(
      node,
      typeChecker.getSymbolAtLocation(node.moduleSpecifier),
      context,
    );
    return;
  }
  if (ts.isNamespaceExport(node.exportClause)) {
    addBoundedEventReferenceDiagnostic(
      node.exportClause.name,
      typeChecker.getSymbolAtLocation(node.moduleSpecifier),
      context,
    );
    return;
  }
  for (const element of node.exportClause.elements) {
    const importedName = element.propertyName?.text ?? element.name.text;
    const symbol =
      typeChecker.getSymbolAtLocation(element.name) ??
      moduleExportSymbol(node.moduleSpecifier, importedName, typeChecker);
    addBoundedEventReferenceDiagnostic(element.name, symbol, context);
  }
}

function importTypeSymbol(node, typeChecker) {
  if (node.qualifier !== undefined) {
    const symbol = typeChecker.getSymbolAtLocation(rightmostEntityName(node.qualifier));
    if (symbol !== undefined) return symbol;
  }
  if (!ts.isLiteralTypeNode(node.argument)) return undefined;
  const moduleSpecifier = node.argument.literal;
  if (node.qualifier === undefined) return typeChecker.getSymbolAtLocation(moduleSpecifier);
  return moduleExportSymbol(moduleSpecifier, rightmostEntityName(node.qualifier).text, typeChecker);
}

function rightmostEntityName(name) {
  return ts.isIdentifier(name) ? name : rightmostEntityName(name.right);
}

function moduleExportSymbol(moduleSpecifier, name, typeChecker) {
  const moduleSymbol = resolveSymbol(typeChecker.getSymbolAtLocation(moduleSpecifier), typeChecker);
  if (moduleSymbol === undefined || (moduleSymbol.flags & ts.SymbolFlags.Module) === 0)
    return undefined;
  return typeChecker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === name);
}

function addBoundedEventReferenceDiagnostic(node, symbolOrNode, context) {
  const { sourceFile, typeChecker, sourceRoot, relativePath, manifests, diagnostics } = context;
  if (symbolOrNode === undefined) return;
  const symbol =
    'kind' in symbolOrNode ? typeChecker.getSymbolAtLocation(symbolOrNode) : symbolOrNode;
  if (!isBoundedEventContractSymbol(symbol, typeChecker, sourceRoot, manifests)) return;
  addDiagnostic(
    sourceFile,
    node,
    relativePath,
    'bounded-event-import-owner',
    'Persistence and Eventing may not import or re-export bounded event contracts',
    diagnostics,
  );
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
  return assignment === undefined
    ? undefined
    : resolveAccessPathKind(
        assignment.expression,
        assignment.accessPath,
        bindings,
        typeChecker,
        sourceRoot,
        seen,
      );
}

function resolveAccessPathKind(expression, accessPath, bindings, typeChecker, sourceRoot, seen) {
  if (accessPath.length === 0)
    return resolveProtectedKind(expression, bindings, typeChecker, sourceRoot, seen);
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const sourceSymbol = typeChecker.getSymbolAtLocation(unwrapped);
    const resolvedSource = resolveSymbol(sourceSymbol, typeChecker);
    const assignment =
      bindings.assignments.get(sourceSymbol) ?? bindings.assignments.get(resolvedSource);
    if (sourceSymbol !== undefined && assignment !== undefined && !seen.has(sourceSymbol)) {
      seen.add(sourceSymbol);
      return resolveAccessPathKind(
        assignment.expression,
        [...assignment.accessPath, ...accessPath],
        bindings,
        typeChecker,
        sourceRoot,
        seen,
      );
    }
  }
  const [head, ...tail] = accessPath;
  const selected = selectedLiteralExpression(unwrapped, head, bindings, typeChecker);
  if (selected !== undefined)
    return resolveAccessPathKind(selected, tail, bindings, typeChecker, sourceRoot, seen);
  const name = head.kind === 'property' ? head.name : String(head.index);
  const symbol = typeChecker.getTypeAtLocation(unwrapped).getProperty(name);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const resolved = resolveSymbol(symbol, typeChecker);
  const kind = protectedSymbolKind(resolved, sourceRoot);
  if (tail.length === 0 && kind !== undefined) return kind;
  const assignment = bindings.assignments.get(symbol) ?? bindings.assignments.get(resolved);
  return assignment === undefined
    ? undefined
    : resolveAccessPathKind(
        assignment.expression,
        [...assignment.accessPath, ...tail],
        bindings,
        typeChecker,
        sourceRoot,
        seen,
      );
}

function selectedLiteralExpression(expression, selector, bindings, typeChecker) {
  if (selector.kind === 'index') {
    if (!ts.isArrayLiteralExpression(expression)) return undefined;
    const selected = expression.elements[selector.index];
    return selected === undefined ||
      ts.isOmittedExpression(selected) ||
      ts.isSpreadElement(selected)
      ? undefined
      : selected;
  }
  if (!ts.isObjectLiteralExpression(expression)) return undefined;
  for (const property of [...expression.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) continue;
    if (propertyName(property.name, bindings, typeChecker) !== selector.name) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
  return undefined;
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
  if (assignment === undefined) return undefined;
  const selected = selectAssignedExpression(
    assignment.expression,
    assignment.accessPath,
    bindings,
    typeChecker,
    seen,
  );
  return selected === undefined ? undefined : staticString(selected, bindings, typeChecker, seen);
}

function selectAssignedExpression(expression, accessPath, bindings, typeChecker, seen) {
  if (accessPath.length === 0) return expression;
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const symbol = typeChecker.getSymbolAtLocation(unwrapped);
    const assignment = symbol === undefined ? undefined : bindings.assignments.get(symbol);
    if (symbol !== undefined && assignment !== undefined && !seen.has(symbol)) {
      seen.add(symbol);
      return selectAssignedExpression(
        assignment.expression,
        [...assignment.accessPath, ...accessPath],
        bindings,
        typeChecker,
        seen,
      );
    }
  }
  const [head, ...tail] = accessPath;
  const selected = selectedLiteralExpression(unwrapped, head, bindings, typeChecker);
  return selected === undefined
    ? undefined
    : selectAssignedExpression(selected, tail, bindings, typeChecker, seen);
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
