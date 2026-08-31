import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  'createBatchEventProcessor',
  'createProjectionProcessor',
]);
const processorRuntimeNames = new Set([
  ...hostNames,
  ...registryNames,
  ...serialiserNames,
  ...processorFactoryNames,
]);
const finiteTupleElementCap = 64;
const handlerPropertyNames = new Set(['handle', 'handler']);
const publishingInfrastructureModules = new Set(['bootstrap', 'eventing', 'persistence']);
const legacyDraftNames = new Set([
  'EventDraft',
  'EventDraftUnion',
  'EventDraftInput',
  'createEventDraft',
  'eventDraftSchema',
]);
/**
 * Enforce event processor and publishing ownership through TypeScript symbols.
 * Imports, namespace members, re-exports, and local aliases resolve to their
 * declarations, leaving unrelated local symbols and dynamic properties alone.
 */
export async function checkEventArchitecture(root = 'src') {
  return (await checkEventArchitectureWithStats(root)).diagnostics;
}

export async function checkEventArchitectureWithStats(root = 'src') {
  const resolvedRoot = resolve(root);
  const sourceRoot = (await directoryExists(join(resolvedRoot, 'src')))
    ? join(resolvedRoot, 'src')
    : resolvedRoot;
  const projectRoot = dirname(sourceRoot);
  const eventingSourceRoot = join(projectRoot, 'packages/eventing/src');
  const hasEventingSource = await directoryExists(eventingSourceRoot);
  const [wakeFiles, eventingFiles, manifests] = await Promise.all([
    typescriptFiles(sourceRoot),
    hasEventingSource ? typescriptFiles(eventingSourceRoot) : [],
    readEventNamespaceManifests(sourceRoot),
  ]);
  const files = [...wakeFiles, ...eventingFiles];
  const compilerOptions = {
    allowJs: false,
    exactOptionalPropertyTypes: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noImplicitOverride: true,
    noUncheckedIndexedAccess: true,
    ...(hasEventingSource
      ? {
          paths: {
            '@atolis-hq/eventing': [join(projectRoot, 'packages/eventing/src/index.ts')],
          },
        }
      : {}),
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const eventingDeclarationEntry = hasEventingSource
    ? undefined
    : resolveEventingDeclarationEntry(sourceRoot, compilerOptions);
  const program = ts.createProgram(
    eventingDeclarationEntry === undefined ? files : [...files, eventingDeclarationEntry],
    compilerOptions,
  );
  const typeChecker = program.getTypeChecker();
  const analysis = createAnalysisState();
  const bindings = collectBindings(program, typeChecker, analysis);
  const canonicalSymbols = collectCanonicalSymbols(program, typeChecker, sourceRoot);
  const canonicalTypes = collectCanonicalTypes(program, typeChecker, sourceRoot, canonicalSymbols);
  analysis.canonicalTypes = canonicalTypes;
  const diagnostics = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) continue;
    const relativePath = normalizeSourcePath(file, sourceRoot);
    const moduleName = isEventingPackagePath(relativePath)
      ? 'eventing'
      : relativePath.split('/')[0];
    inspectProcessorRuntimeReferences(
      sourceFile,
      bindings,
      typeChecker,
      sourceRoot,
      relativePath,
      diagnostics,
      analysis,
    );
    if (moduleName === 'persistence') {
      inspectPersistenceProcessors(
        sourceFile,
        bindings,
        typeChecker,
        sourceRoot,
        relativePath,
        diagnostics,
        analysis,
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
      canonicalTypes,
      diagnostics,
      analysis,
    });
  }

  return {
    diagnostics,
    stats: {
      originEdges: analysis.originEdges.size,
      uniqueOriginStates: analysis.originStates.size,
    },
  };
}

function createAnalysisState() {
  return {
    finiteArrayMemo: new Map(),
    memo: new Map(),
    nodeIds: new WeakMap(),
    nextNodeId: 1,
    originEdges: new Set(),
    originStates: new Set(),
  };
}

function collectBindings(program, typeChecker, analysis) {
  const assignments = new Map();
  const bindings = { analysis, assignments, memberAssignments: new Map() };

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      collectBindingAssignments(
        node.name,
        [{ expression: node.initializer, accessPath: [] }],
        bindings,
        typeChecker,
        assignments,
        assignmentSite(node),
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      !isWithinOuterAssignmentTarget(node)
    )
      collectAssignmentTarget(
        node.left,
        [{ expression: node.right, accessPath: [] }],
        bindings,
        typeChecker,
        assignments,
        assignmentSite(node),
      );
    ts.forEachChild(node, visit);
  }

  for (const sourceFile of program.getSourceFiles())
    if (!sourceFile.isDeclarationFile || normalizePath(sourceFile.fileName).includes('/src/'))
      visit(sourceFile);
  return bindings;
}

function assignmentSite(node) {
  return {
    container: containingFunction(node),
    position: node.getEnd(),
    sourceFile: node.getSourceFile(),
  };
}

function containingFunction(node) {
  for (let current = node.parent; current !== undefined; current = current.parent)
    if (ts.isFunctionLike(current)) return current;
  return undefined;
}

function collectBindingAssignments(pattern, origins, bindings, typeChecker, assignments, site) {
  if (ts.isIdentifier(pattern)) {
    const symbol = typeChecker.getSymbolAtLocation(pattern);
    if (symbol !== undefined) addAssignment(assignments, symbol, { ...site, origins });
    return;
  }
  if (ts.isObjectBindingPattern(pattern)) {
    const excluded = [];
    for (const element of pattern.elements) {
      if (element.dotDotDotToken !== undefined) {
        collectBindingAssignments(
          element.name,
          appendOriginAccess(origins, { kind: 'object-rest', excluded: [...excluded] }),
          bindings,
          typeChecker,
          assignments,
          site,
        );
        continue;
      }
      const name = bindingPropertyName(element, bindings, typeChecker);
      if (name === undefined) continue;
      excluded.push(name);
      const selectedOrigins = appendOriginAccess(origins, { kind: 'property', name });
      collectBindingAssignments(
        element.name,
        withDefaultOrigin(selectedOrigins, element.initializer),
        bindings,
        typeChecker,
        assignments,
        site,
      );
    }
    return;
  }
  if (ts.isArrayBindingPattern(pattern))
    for (const [index, element] of pattern.elements.entries()) {
      if (!ts.isBindingElement(element)) continue;
      const selector =
        element.dotDotDotToken === undefined
          ? { kind: 'index', index }
          : { kind: 'array-rest', start: index };
      const selectedOrigins = appendOriginAccess(origins, selector);
      collectBindingAssignments(
        element.name,
        withDefaultOrigin(selectedOrigins, element.initializer),
        bindings,
        typeChecker,
        assignments,
        site,
      );
    }
}

function collectAssignmentTarget(target, origins, bindings, typeChecker, assignments, site) {
  const unwrapped = unwrapExpression(target);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    collectAssignmentTarget(
      unwrapped.left,
      withDefaultOrigin(origins, unwrapped.right),
      bindings,
      typeChecker,
      assignments,
      site,
    );
    return;
  }
  if (ts.isIdentifier(unwrapped)) {
    const symbol = typeChecker.getSymbolAtLocation(unwrapped);
    if (symbol !== undefined) addAssignment(assignments, symbol, { ...site, origins });
    return;
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    addMemberAssignment(bindings.memberAssignments, {
      ...site,
      origins,
      target: unwrapped,
    });
    return;
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    for (const [index, element] of unwrapped.elements.entries()) {
      if (ts.isOmittedExpression(element)) continue;
      const elementTarget = ts.isSpreadElement(element) ? element.expression : element;
      const selector = ts.isSpreadElement(element)
        ? { kind: 'array-rest', start: index }
        : { kind: 'index', index };
      collectAssignmentTarget(
        elementTarget,
        appendOriginAccess(origins, selector),
        bindings,
        typeChecker,
        assignments,
        site,
      );
    }
    return;
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) return;
  const excluded = [];
  for (const property of unwrapped.properties) {
    if (ts.isSpreadAssignment(property)) {
      collectAssignmentTarget(
        property.expression,
        appendOriginAccess(origins, { kind: 'object-rest', excluded: [...excluded] }),
        bindings,
        typeChecker,
        assignments,
        site,
      );
      continue;
    }
    const name = propertyName(property.name, bindings, typeChecker);
    if (name === undefined) continue;
    excluded.push(name);
    const propertyTarget = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : ts.isPropertyAssignment(property)
        ? property.initializer
        : undefined;
    if (propertyTarget !== undefined)
      collectAssignmentTarget(
        propertyTarget,
        withDefaultOrigin(
          appendOriginAccess(origins, { kind: 'property', name }),
          ts.isShorthandPropertyAssignment(property)
            ? property.objectAssignmentInitializer
            : undefined,
        ),
        bindings,
        typeChecker,
        assignments,
        site,
      );
  }
}

function isWithinOuterAssignmentTarget(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return false;
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return node.pos >= current.left.pos && node.end <= current.left.end;
    if (ts.isStatement(current)) return false;
  }
  return false;
}

function addAssignment(assignments, symbol, assignment) {
  const history = assignments.get(symbol);
  if (history === undefined) assignments.set(symbol, [assignment]);
  else history.push(assignment);
}

function addMemberAssignment(memberAssignments, assignment) {
  const sourceAssignments = memberAssignments.get(assignment.sourceFile);
  if (sourceAssignments === undefined) memberAssignments.set(assignment.sourceFile, [assignment]);
  else sourceAssignments.push(assignment);
}

function assignmentAt(bindings, symbol, useNode) {
  const history = bindings.assignments.get(symbol);
  if (history === undefined) return undefined;
  const useSource = useNode.getSourceFile();
  const usePosition = useNode.getStart(useSource);
  let current;
  for (const assignment of history) {
    if (
      (assignment.sourceFile !== useSource || assignment.position <= usePosition) &&
      assignmentContainerIncludesUse(assignment.container, useNode)
    )
      current = assignment;
  }
  return current;
}

function assignmentContainerIncludesUse(container, useNode) {
  if (container === undefined) return true;
  for (let current = useNode; current !== undefined; current = current.parent)
    if (current === container) return true;
  return false;
}

function assignmentAtSite(bindings, symbol, site) {
  if (symbol === undefined) return undefined;
  const history = bindings.assignments.get(symbol);
  return history?.find(
    (candidate) =>
      candidate.sourceFile === site.getSourceFile() && candidate.position === site.getEnd(),
  );
}

function appendOriginAccess(origins, selector) {
  return origins.map(({ expression, accessPath }) => ({
    expression,
    accessPath: [...accessPath, selector],
  }));
}

function withDefaultOrigin(origins, initializer) {
  return initializer === undefined
    ? origins
    : [...origins, { expression: initializer, accessPath: [] }];
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
    if (isCanonicalDiscoveryFile(sourceFile, sourceRoot)) visit(sourceFile);
  return symbols;
}

function collectCanonicalTypes(program, typeChecker, sourceRoot, canonicalSymbols) {
  const types = new Map();
  for (const [kind, symbol] of canonicalSymbols)
    addCanonicalType(types, kind, typeChecker.getDeclaredTypeOfSymbol(symbol));

  function visit(node) {
    if (ts.isTypeReferenceNode(node)) {
      const symbol = resolveSymbol(
        typeChecker.getSymbolAtLocation(rightmostEntityName(node.typeName)),
        typeChecker,
      );
      const kind = protectedSymbolKind(symbol, sourceRoot);
      if (kind !== undefined) addCanonicalType(types, kind, typeChecker.getTypeFromTypeNode(node));
    }
    if (ts.isExpressionWithTypeArguments(node)) {
      const symbol = resolveSymbol(typeChecker.getSymbolAtLocation(node.expression), typeChecker);
      const kind = protectedSymbolKind(symbol, sourceRoot);
      if (kind !== undefined) addCanonicalType(types, kind, typeChecker.getTypeAtLocation(node));
    }
    ts.forEachChild(node, visit);
  }

  for (const sourceFile of program.getSourceFiles())
    if (isCanonicalDiscoveryFile(sourceFile, sourceRoot)) visit(sourceFile);
  return types;
}

function resolveEventingDeclarationEntry(sourceRoot, compilerOptions) {
  const containingFile = join(sourceRoot, '__eventing-architecture__.ts');
  const resolution = ts.resolveModuleName(
    '@atolis-hq/eventing',
    containingFile,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  return resolution?.resolvedFileName;
}

function isCanonicalDiscoveryFile(sourceFile, sourceRoot) {
  return (
    !sourceFile.isDeclarationFile ||
    isEventingPackagePath(normalizeSourcePath(sourceFile.fileName, sourceRoot))
  );
}

function addCanonicalType(types, kind, type) {
  const candidates = types.get(kind);
  if (candidates === undefined) types.set(kind, new Set([type]));
  else candidates.add(type);
}

function inspectProcessorRuntimeReferences(
  sourceFile,
  bindings,
  typeChecker,
  sourceRoot,
  relativePath,
  diagnostics,
) {
  const reported = new Set();

  for (const assignment of bindings.memberAssignments.get(sourceFile) ?? []) {
    const kinds = resolveMemberAssignmentKinds(
      assignment,
      bindings,
      typeChecker,
      sourceRoot,
      assignment.target,
    );
    for (const kind of kinds) {
      if (
        isApprovedProcessorRuntimeReference(kind, relativePath) ||
        assignment.origins.some(({ expression }) =>
          containsReportableDirectProcessorRuntimeReference(
            expression,
            bindings,
            typeChecker,
            sourceRoot,
            relativePath,
            kind,
          ),
        )
      )
        continue;
      reportProcessorRuntimeReference(
        { node: assignment.target, kind },
        sourceRoot,
        diagnostics,
        reported,
      );
    }
  }

  function visit(node) {
    const reference = protectedProcessorRuntimeReference(node, bindings, typeChecker, sourceRoot);
    if (
      reference !== undefined &&
      !isExcludedRuntimeReference(reference.node) &&
      !isApprovedProcessorRuntimeReference(reference.kind, relativePath)
    )
      reportProcessorRuntimeReference(reference, sourceRoot, diagnostics, reported);
    const binding = protectedProcessorStructuralBinding(
      node,
      bindings,
      typeChecker,
      sourceRoot,
      relativePath,
    );
    if (binding !== undefined && !isApprovedProcessorRuntimeReference(binding.kind, relativePath))
      reportProcessorRuntimeReference(binding, sourceRoot, diagnostics, reported);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function resolveMemberAssignmentKinds(assignment, bindings, typeChecker, sourceRoot, useNode) {
  const kinds = new Set();
  addProcessorRuntimeKind(
    kinds,
    resolveAssignmentOrigins(assignment, [], bindings, typeChecker, sourceRoot, useNode, new Set()),
  );
  for (const origin of assignment.origins) {
    const rest = origin.accessPath.at(-1);
    if (rest?.kind === 'object-rest') {
      for (const name of processorRuntimeNames)
        addProcessorRuntimeKind(
          kinds,
          resolveAccessPathKind(
            origin.expression,
            [...origin.accessPath, { kind: 'property', name }],
            bindings,
            typeChecker,
            sourceRoot,
            useNode,
            new Set(),
          ),
        );
      continue;
    }
    if (rest?.kind !== 'array-rest') continue;
    for (const element of finiteArrayRestElements(
      origin.expression,
      origin.accessPath.slice(0, -1),
      rest.start,
      bindings,
      typeChecker,
    )) {
      const directKind = resolveAccessPathKind(
        element.expression,
        element.accessPath,
        bindings,
        typeChecker,
        sourceRoot,
        useNode,
        new Set(),
      );
      addProcessorRuntimeKind(kinds, directKind);
      for (const name of processorRuntimeNames) {
        const propertyKind = resolveAccessPathKind(
          element.expression,
          [...element.accessPath, { kind: 'property', name }],
          bindings,
          typeChecker,
          sourceRoot,
          useNode,
          new Set(),
        );
        addProcessorRuntimeKind(kinds, propertyKind);
      }
    }
  }
  return kinds;
}

function addProcessorRuntimeKind(kinds, kind) {
  if (isProcessorRuntimeKind(kind)) kinds.add(kind);
}

function finiteArrayRestElements(expression, prefix, start, bindings, typeChecker) {
  const expansion = finiteArrayElements(expression, prefix, bindings, typeChecker, new Set());
  return expansion.elements.slice(start).filter((element) => element !== undefined);
}

function finiteArrayElements(expression, prefix, bindings, typeChecker, activeStates) {
  const stateKey = `finite-array:${nodeId(expression, bindings.analysis)}:${serializeAccessPath(prefix)}`;
  const cached = bindings.analysis.finiteArrayMemo.get(stateKey);
  if (cached !== undefined) return cached;
  if (activeStates.has(stateKey)) return { complete: false, elements: [] };
  activeStates.add(stateKey);
  const literal = selectedLiteralAtStaticPath(expression, prefix, bindings, typeChecker);
  const expansion =
    literal !== undefined && ts.isArrayLiteralExpression(literal)
      ? finiteArrayLiteralElements(literal, bindings, typeChecker, activeStates)
      : finiteTupleElements(expression, prefix, typeChecker);
  activeStates.delete(stateKey);
  bindings.analysis.finiteArrayMemo.set(stateKey, expansion);
  return expansion;
}

function finiteArrayLiteralElements(literal, bindings, typeChecker, activeStates) {
  const elements = [];
  for (const literalElement of literal.elements) {
    if (elements.length >= finiteTupleElementCap)
      return { complete: false, elements: elements.slice(0, finiteTupleElementCap) };
    if (ts.isOmittedExpression(literalElement)) {
      elements.push(undefined);
      continue;
    }
    if (!ts.isSpreadElement(literalElement)) {
      elements.push({
        accessPath: [],
        expression: literalElement,
      });
      continue;
    }
    const spread = finiteArrayElements(
      literalElement.expression,
      [],
      bindings,
      typeChecker,
      activeStates,
    );
    const remaining = finiteTupleElementCap - elements.length;
    elements.push(...spread.elements.slice(0, remaining));
    if (!spread.complete || spread.elements.length > remaining)
      return { complete: false, elements };
  }
  return { complete: true, elements };
}

function finiteTupleElements(expression, prefix, typeChecker) {
  const type = typeAtStaticPath(expression, prefix, typeChecker);
  if (type === undefined || !typeChecker.isTupleType(type))
    return { complete: false, elements: [] };
  const lengthSymbol = type.getProperty('length');
  if (lengthSymbol === undefined) return { complete: false, elements: [] };
  const lengthType = typeChecker.getTypeOfSymbolAtLocation(lengthSymbol, expression);
  if ((lengthType.flags & ts.TypeFlags.NumberLiteral) === 0)
    return { complete: false, elements: [] };
  const length = lengthType.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > finiteTupleElementCap)
    return { complete: false, elements: [] };
  const elements = [];
  for (let index = 0; index < length; index += 1) {
    const symbol = type.getProperty(String(index));
    if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Optional) !== 0)
      return { complete: false, elements: [] };
    elements.push({
      accessPath: [...prefix, { kind: 'index', index }],
      expression,
    });
  }
  return { complete: true, elements };
}

function selectedLiteralAtStaticPath(expression, accessPath, bindings, typeChecker) {
  let selected = unwrapExpression(expression);
  for (const selector of accessPath) {
    const next = selectedLiteralExpression(selected, selector, bindings, typeChecker);
    if (next === undefined) return undefined;
    selected = unwrapExpression(next);
  }
  return selected;
}

function typeAtStaticPath(expression, accessPath, typeChecker) {
  let type = typeChecker.getTypeAtLocation(expression);
  for (const selector of accessPath) {
    if (selector.kind !== 'property' && selector.kind !== 'index') return undefined;
    const symbol = type.getProperty(
      selector.kind === 'property' ? selector.name : String(selector.index),
    );
    if (symbol === undefined) return undefined;
    type = typeChecker.getTypeOfSymbolAtLocation(symbol, expression);
  }
  return type;
}

function protectedProcessorRuntimeReference(node, bindings, typeChecker, sourceRoot) {
  if (ts.isIdentifier(node)) {
    const symbol = resolveSymbol(typeChecker.getSymbolAtLocation(node), typeChecker);
    const kind = protectedSymbolKind(symbol, sourceRoot);
    return isProcessorRuntimeKind(kind) ? { node, kind } : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    const symbol = resolveSymbol(expressionSymbol(node, bindings, typeChecker), typeChecker);
    const kind = protectedSymbolKind(symbol, sourceRoot);
    return isProcessorRuntimeKind(kind) ? { node, kind } : undefined;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const direct = resolveSymbol(expressionSymbol(node, bindings, typeChecker), typeChecker);
    if (isProcessorRuntimeKind(protectedSymbolKind(direct, sourceRoot))) return undefined;
    const kind = resolveStructuralDeclarationAccessKind(node, bindings, typeChecker, sourceRoot);
    return isProcessorRuntimeKind(kind) ? { node, kind } : undefined;
  }
  return undefined;
}

function protectedProcessorStructuralBinding(
  node,
  bindings,
  typeChecker,
  sourceRoot,
  relativePath,
) {
  if (!ts.isIdentifier(node)) return undefined;
  const site = bindingSite(node);
  if (site === undefined) return undefined;
  const symbol = typeChecker.getSymbolAtLocation(node);
  const assignment = assignmentAtSite(bindings, symbol, site);
  if (
    assignment === undefined ||
    !assignment.origins.some(({ accessPath }) =>
      accessPath.some(
        (selector) => selector.kind === 'property' && processorRuntimeNames.has(selector.name),
      ),
    )
  )
    return undefined;
  const kind = resolveAssignmentOrigins(
    assignment,
    [],
    bindings,
    typeChecker,
    sourceRoot,
    site,
    new Set(),
  );
  if (
    !isProcessorRuntimeKind(kind) ||
    assignment.origins.some(({ expression }) =>
      containsReportableDirectProcessorRuntimeReference(
        expression,
        bindings,
        typeChecker,
        sourceRoot,
        relativePath,
        kind,
      ),
    )
  )
    return undefined;
  return { node, kind };
}

function resolveStructuralDeclarationAccessKind(node, bindings, typeChecker, sourceRoot) {
  const access = aliasedAccess(node, bindings, typeChecker);
  if (access === undefined) return undefined;
  const symbol = typeChecker.getSymbolAtLocation(access.base);
  const declarationSite = bindingDeclarationSite(symbol?.valueDeclaration);
  if (declarationSite === undefined) return undefined;
  const assignment = assignmentAtSite(bindings, symbol, declarationSite);
  if (assignment === undefined) return undefined;
  return resolveAssignmentOrigins(
    assignment,
    access.accessPath,
    bindings,
    typeChecker,
    sourceRoot,
    node,
    new Set([symbol]),
  );
}

function bindingDeclarationSite(declaration) {
  for (let current = declaration; current !== undefined; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return current;
    if (ts.isStatement(current)) return undefined;
  }
  return undefined;
}

function containsReportableDirectProcessorRuntimeReference(
  node,
  bindings,
  typeChecker,
  sourceRoot,
  relativePath,
  expectedKind,
) {
  let found = false;
  function visit(current) {
    if (found) return;
    const reference = protectedProcessorRuntimeReference(
      current,
      bindings,
      typeChecker,
      sourceRoot,
    );
    if (
      reference !== undefined &&
      reference.kind === expectedKind &&
      !isExcludedRuntimeReference(reference.node) &&
      !isApprovedProcessorRuntimeReference(reference.kind, relativePath)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function isProcessorRuntimeKind(kind) {
  return ['host', 'registry', 'serialiser', 'processor-factory'].includes(kind);
}

function isExcludedRuntimeReference(node) {
  if (isWithinImport(node) || isWithinTypePosition(node) || isTypeOnlyExportReference(node))
    return true;
  const parent = node.parent;
  if (
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isPropertyAssignment(parent) &&
      parent.name === node &&
      isWithinOuterAssignmentTarget(parent))
  )
    return true;
  return (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent)) &&
    parent.name === node
  );
}

function isApprovedProcessorRuntimeReference(kind, relativePath) {
  if (kind === 'host')
    return isEventingPackagePath(relativePath) || relativePath.startsWith('bootstrap/');
  if (kind === 'registry') return relativePath.startsWith('bootstrap/');
  if (kind === 'serialiser')
    return relativePath.startsWith('persistence/') || relativePath.startsWith('bootstrap/');
  return kind === 'processor-factory' && !relativePath.startsWith('persistence/');
}

function addProcessorRuntimeReferenceDiagnostic(reference, sourceRoot, diagnostics) {
  if (reference.kind === 'host')
    addDiagnostic(
      reference.node,
      sourceRoot,
      'event-processor-host-owner',
      'EventProcessorHost runtime references are restricted to eventing and bootstrap',
      diagnostics,
    );
  if (reference.kind === 'registry')
    addDiagnostic(
      reference.node,
      sourceRoot,
      'processor-registry-owner',
      'EventProcessorRuntime runtime references are restricted to bootstrap',
      diagnostics,
    );
  if (reference.kind === 'serialiser')
    addDiagnostic(
      reference.node,
      sourceRoot,
      'processor-serialiser-owner',
      'processor serialiser runtime references are restricted to persistence and bootstrap',
      diagnostics,
    );
  if (reference.kind === 'processor-factory')
    addDiagnostic(
      reference.node,
      sourceRoot,
      'persistence-processor-handler',
      'persistence may not define handlers for Eventing processors',
      diagnostics,
    );
}

function reportProcessorRuntimeReference(reference, sourceRoot, diagnostics, reported) {
  const sourceFile = reference.node.getSourceFile();
  const key = `${reference.kind}:${sourceFile.fileName}:${reference.node.getStart(sourceFile)}`;
  if (reported.has(key)) return;
  reported.add(key);
  addProcessorRuntimeReferenceDiagnostic(reference, sourceRoot, diagnostics);
}

function inspectPersistenceProcessors(
  sourceFile,
  bindings,
  typeChecker,
  sourceRoot,
  relativePath,
  diagnostics,
  analysis,
) {
  const reported = new Set();
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const symbol = resolveSymbol(
        expressionSymbol(node.expression, bindings, typeChecker),
        typeChecker,
      );
      const kind = protectedSymbolKind(symbol, sourceRoot);
      if (kind === 'processor-factory') {
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
    if (
      ts.isObjectLiteralExpression(node) &&
      isProcessorDefinitionConstruction(node, typeChecker, sourceRoot, analysis.canonicalTypes) &&
      !isLocallyShadowedProcessorFactoryArgument(node, bindings, typeChecker, sourceRoot)
    )
      addPersistenceDiagnostic(node, sourceRoot, diagnostics, reported);
    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      isProcessorDefinitionClass(node, typeChecker, analysis.canonicalTypes)
    )
      addPersistenceDiagnostic(node.name ?? node, sourceRoot, diagnostics, reported);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function isLocallyShadowedProcessorFactoryArgument(node, bindings, typeChecker, sourceRoot) {
  const call = node.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(node)) return false;
  const symbol = expressionSymbol(call.expression, bindings, typeChecker);
  const assignment = symbol === undefined ? undefined : assignmentAt(bindings, symbol, call);
  return (
    assignment !== undefined &&
    resolveProtectedKind(call.expression, bindings, typeChecker, sourceRoot, call) !==
      'processor-factory'
  );
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
        addPersistenceDiagnostic(property, sourceRoot, diagnostics, reported);
    }
    return;
  }
  if (ts.isIdentifier(expression)) {
    const symbol = typeChecker.getSymbolAtLocation(expression);
    const assignment =
      symbol === undefined ? undefined : assignmentAt(bindings, symbol, expression);
    for (const origin of assignment?.origins ?? [])
      if (origin.accessPath.length === 0)
        inspectLinkedHandlerProperties(
          origin.expression,
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
    canonicalTypes,
    diagnostics,
  } = context;

  inspectBoundedEventImports(context);

  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (isLegacyJournalAppendCall(node, bindings, typeChecker, sourceRoot))
        addDiagnostic(
          node,
          sourceRoot,
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
        node,
        sourceRoot,
        'legacy-event-journal-append',
        'EventJournal must not declare the legacy append method',
        diagnostics,
      );
    inspectEventDataFactoryReference(node, context);
    inspectEventDataFactoryBinding(node, context);
    if (
      isConstructionExpression(node, bindings, typeChecker, sourceRoot) &&
      isEventEnvelopeConstruction(node, typeChecker, sourceRoot, canonicalTypes) &&
      !isApprovedEnvelopeConstruction(node, relativePath, typeChecker, sourceRoot)
    )
      addDiagnostic(
        node,
        sourceRoot,
        'event-envelope-construction-owner',
        'journal envelope metadata may only be constructed by approved journal adapters',
        diagnostics,
      );
    if (
      isConstructionExpression(node, bindings, typeChecker, sourceRoot) &&
      publishingInfrastructureModules.has(moduleName) &&
      isBoundedEventDataConstruction(node, typeChecker, sourceRoot, manifests, canonicalTypes)
    )
      addDiagnostic(
        node,
        sourceRoot,
        'bounded-event-data-construction',
        'Bootstrap, Persistence, and Eventing must delegate bounded EventData construction to its owner',
        diagnostics,
      );
    if (ts.isIdentifier(node) && legacyDraftNames.has(node.text) && !isTestPath(relativePath))
      addDiagnostic(
        node,
        sourceRoot,
        'legacy-event-draft-symbol',
        `${node.text} is legacy production vocabulary; use EventData`,
        diagnostics,
      );
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function inspectEventDataFactoryBinding(node, context) {
  if (!ts.isIdentifier(node)) return;
  const site = bindingSite(node);
  if (site === undefined) return;
  const symbol = context.typeChecker.getSymbolAtLocation(node);
  const history = context.bindings.assignments.get(symbol);
  const assignment = history?.find(
    (candidate) =>
      candidate.sourceFile === site.getSourceFile() && candidate.position === site.getEnd(),
  );
  if (assignment === undefined) return;
  if (
    !assignment.origins.some(({ accessPath }) =>
      accessPath.some(
        (selector) => selector.kind === 'property' && selector.name === 'createEventData',
      ),
    )
  )
    return;
  if (
    assignment.origins.some(({ expression }) =>
      containsDirectFactoryReference(expression, context.typeChecker, context.sourceRoot),
    ) ||
    containsDirectFactoryReference(site.name ?? site.left, context.typeChecker, context.sourceRoot)
  )
    return;
  const kind = resolveAssignmentOrigins(
    assignment,
    [],
    context.bindings,
    context.typeChecker,
    context.sourceRoot,
    site,
    new Set(),
  );
  if (kind !== 'event-data-factory') return;
  addDiagnostic(
    node,
    context.sourceRoot,
    'event-data-factory-owner',
    'Eventing createEventData runtime references are restricted to direct, manifest-owned factory calls',
    context.diagnostics,
  );
}

function bindingSite(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isVariableDeclaration(current))
      return node.pos >= current.name.pos && node.end <= current.name.end ? current : undefined;
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      if (isWithinOuterAssignmentTarget(current)) continue;
      return node.pos >= current.left.pos && node.end <= current.left.end ? current : undefined;
    }
    if (ts.isStatement(current)) return undefined;
  }
  return undefined;
}

function inspectEventDataFactoryReference(node, context) {
  const { bindings, typeChecker, sourceRoot } = context;
  const reference = eventDataFactoryReference(node, bindings, typeChecker, sourceRoot);
  if (reference === undefined || isExcludedFactoryReference(reference, context)) return;
  if (
    isEventingContractTestPath(context.relativePath) ||
    isEnvelopeTestHelperPath(context.relativePath)
  )
    return;
  if (isAllowedOwnerFactoryCall(reference, context)) return;
  addDiagnostic(
    reference,
    context.sourceRoot,
    'event-data-factory-owner',
    'Eventing createEventData runtime references are restricted to direct, manifest-owned factory calls',
    context.diagnostics,
  );
}

function eventDataFactoryReference(node, bindings, typeChecker, sourceRoot) {
  if (ts.isIdentifier(node)) {
    const symbol = resolveSymbol(typeChecker.getSymbolAtLocation(node), typeChecker);
    return protectedSymbolKind(symbol, sourceRoot) === 'event-data-factory' ? node : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    const symbol = resolveSymbol(expressionSymbol(node, bindings, typeChecker), typeChecker);
    if (protectedSymbolKind(symbol, sourceRoot) === 'event-data-factory') return node;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const direct = resolveSymbol(expressionSymbol(node, bindings, typeChecker), typeChecker);
    if (protectedSymbolKind(direct, sourceRoot) !== undefined) return undefined;
    if (
      resolveProtectedKind(node, bindings, typeChecker, sourceRoot) === 'event-data-factory' &&
      !aliasedAccessHasDirectFactoryOrigin(node, bindings, typeChecker, sourceRoot)
    )
      return node;
  }
  return undefined;
}

function isExcludedFactoryReference(node, context) {
  if (isWithinImport(node) || isWithinTypePosition(node)) return true;
  if (isTypeOnlyExportReference(node)) return true;
  const parent = node.parent;
  if (ts.isExportSpecifier(parent) && parent.name === node && parent.propertyName !== undefined)
    return true;
  if (
    context.moduleName === 'eventing' &&
    isEventingPackagePath(context.relativePath) &&
    (ts.isExportSpecifier(parent) || ts.isExportDeclaration(parent))
  )
    return true;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent)) &&
    parent.name === node
  )
    return true;
  return false;
}

function aliasedAccessHasDirectFactoryOrigin(node, bindings, typeChecker, sourceRoot) {
  const access = aliasedAccess(node, bindings, typeChecker);
  if (access === undefined) return false;
  const symbol = typeChecker.getSymbolAtLocation(access.base);
  const resolved = resolveSymbol(symbol, typeChecker);
  const assignment = assignmentAt(bindings, symbol, node) ?? assignmentAt(bindings, resolved, node);
  return assignment?.origins.some(({ expression }) =>
    containsDirectFactoryReference(expression, typeChecker, sourceRoot),
  );
}

function containsDirectFactoryReference(node, typeChecker, sourceRoot) {
  let found = false;
  function visit(current) {
    if (found) return;
    if (ts.isIdentifier(current)) {
      const symbol = resolveSymbol(typeChecker.getSymbolAtLocation(current), typeChecker);
      if (protectedSymbolKind(symbol, sourceRoot) === 'event-data-factory') {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function isWithinImport(node) {
  for (let current = node; current !== undefined; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isImportEqualsDeclaration(current)) return true;
    if (ts.isStatement(current)) return false;
  }
  return false;
}

function isWithinTypePosition(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current)) return false;
  }
  return false;
}

function isTypeOnlyExportReference(node) {
  const specifier = ts.isExportSpecifier(node.parent) ? node.parent : undefined;
  if (specifier === undefined) return false;
  if (specifier?.isTypeOnly === true) return true;
  const declaration = specifier.parent.parent;
  return ts.isExportDeclaration(declaration) && declaration.isTypeOnly;
}

function isAllowedOwnerFactoryCall(reference, context) {
  const expression = referenceExpression(reference);
  const parent = expression.parent;
  if (!ts.isCallExpression(parent) || unwrapExpression(parent.expression) !== expression)
    return false;
  if (!isApprovedEventDataFactoryPath(context.relativePath, context.moduleName, context.manifests))
    return false;
  const eventTypes = eventTypeLiteralValues(parent.arguments[0], context.typeChecker);
  const namespaces = context.manifests.get(context.moduleName) ?? [];
  return (
    eventTypes.length > 0 &&
    eventTypes.every((eventType) => namespaces.some((namespace) => eventType.startsWith(namespace)))
  );
}

function referenceExpression(reference) {
  const parent = reference.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === reference) return parent;
  return reference;
}

function eventTypeLiteralValues(node, typeChecker) {
  if (node === undefined) return [];
  const type = typeChecker.getTypeAtLocation(node);
  const property = type.getProperty('eventType');
  if (property === undefined) return [];
  const eventType = typeChecker.getTypeOfSymbolAtLocation(property, node);
  return stringLiteralValues(eventType);
}

function stringLiteralValues(type) {
  const members = type.isUnion() ? type.types : [type];
  const values = [];
  for (const member of members) {
    if ((member.flags & ts.TypeFlags.StringLiteral) === 0) return [];
    values.push(member.value);
  }
  return [...new Set(values)];
}

function isEnvelopeTestHelperPath(relativePath) {
  return pathMatches(relativePath, 'test/support/event-envelope.ts');
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
  const { typeChecker, sourceRoot, manifests, diagnostics } = context;
  if (symbolOrNode === undefined) return;
  const symbol =
    'kind' in symbolOrNode ? typeChecker.getSymbolAtLocation(symbolOrNode) : symbolOrNode;
  if (!isBoundedEventContractSymbol(symbol, typeChecker, sourceRoot, manifests)) return;
  addDiagnostic(
    node,
    sourceRoot,
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
  const file = basename(path).replace(/\.(?:cts|mts|tsx?)$/u, '.ts');
  return (
    file === 'events.ts' ||
    file.endsWith('-events.ts') ||
    file === 'intents.ts' ||
    file === 'event-factory.ts' ||
    file.endsWith('-event-factory.ts')
  );
}

function isApprovedEventDataFactoryPath(relativePath, moduleName, manifests) {
  if (isEventingContractTestPath(relativePath) || isEnvelopeTestHelperPath(relativePath))
    return true;
  if ((manifests.get(moduleName)?.length ?? 0) === 0) return false;
  return /\/contracts\/[^/]*event-factory\.(?:cts|mts|tsx?)$/u.test(relativePath);
}

function isApprovedEnvelopeConstructionPath(relativePath) {
  if (pathMatches(relativePath, 'test/support/event-envelope.ts')) return true;
  return (
    /^persistence\/(?:filesystem|memory)\/[^/]*event-journal\.ts$/u.test(relativePath) ||
    /^\.\.\/packages\/eventing\/src\/memory\/[^/]*event-journal\.ts$/u.test(relativePath) ||
    pathMatches(relativePath, 'persistence/filesystem/event-record-codec.ts')
  );
}

function isApprovedEnvelopeConstruction(node, relativePath, typeChecker, sourceRoot) {
  if (isApprovedEnvelopeConstructionPath(relativePath)) return true;
  if (!eventingModulePathMatches(relativePath, 'contracts/event-schema')) return false;
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) &&
      current.name !== undefined
    ) {
      const symbol = resolveSymbol(typeChecker.getSymbolAtLocation(current.name), typeChecker);
      return protectedSymbolKind(symbol, sourceRoot) === 'event-envelope-decoder';
    }
  }
  return false;
}

function isConstructionExpression(node, bindings, typeChecker, sourceRoot) {
  return (
    ts.isObjectLiteralExpression(node) ||
    ts.isNewExpression(node) ||
    (ts.isCallExpression(node) &&
      resolveProtectedKind(node.expression, bindings, typeChecker, sourceRoot, node) ===
        'object-assign')
  );
}

function isEventingContractTestPath(relativePath) {
  return (
    /^test\/unit\/eventing\/.*\.test\.(?:cts|mts|tsx?)$/u.test(relativePath) ||
    /^unit\/eventing\/.*\.test\.(?:cts|mts|tsx?)$/u.test(relativePath)
  );
}

function isTestPath(relativePath) {
  return (
    relativePath.startsWith('test/') ||
    relativePath.includes('/test/') ||
    /\.test\.(?:cts|mts|tsx?)$/u.test(relativePath)
  );
}

function isEventEnvelopeConstruction(node, typeChecker, sourceRoot, canonicalTypes) {
  const contextualType = typeChecker.getContextualType(node);
  if (
    typeContainsProtectedKind(contextualType, 'event-envelope', typeChecker, sourceRoot) &&
    typeChecker.isTypeAssignableTo(typeChecker.getTypeAtLocation(node), contextualType)
  )
    return true;
  return isAssignableToCanonicalType(node, 'event-envelope', typeChecker, canonicalTypes);
}

function isBoundedEventDataConstruction(node, typeChecker, sourceRoot, manifests, canonicalTypes) {
  if (!isAssignableToCanonicalType(node, 'event-data', typeChecker, canonicalTypes)) return false;
  const nodeType = typeChecker.getTypeAtLocation(node);
  const contextualType = typeChecker.getContextualType(node);
  if (
    typeContainsProtectedKind(contextualType, 'event-data', typeChecker, sourceRoot) &&
    boundedEventOwnerForType(contextualType, typeChecker, sourceRoot, manifests) !== undefined
  )
    return true;
  const eventTypeProperty = nodeType.getProperty('eventType');
  if (eventTypeProperty === undefined) return false;
  const eventTypes = stringLiteralValues(
    typeChecker.getTypeOfSymbolAtLocation(eventTypeProperty, node),
  );
  return eventTypes.some((eventType) => ownerForEventType(eventType, manifests) !== undefined);
}

function isProcessorDefinitionConstruction(node, typeChecker, sourceRoot, canonicalTypes) {
  const contextualType = typeChecker.getContextualType(node);
  if (
    (typeContainsProtectedKind(contextualType, 'processor-definition', typeChecker, sourceRoot) ||
      typeContainsProtectedKind(
        contextualType,
        'batch-processor-definition',
        typeChecker,
        sourceRoot,
      )) &&
    typeChecker.isTypeAssignableTo(typeChecker.getTypeAtLocation(node), contextualType)
  )
    return true;
  return ['processor-definition', 'batch-processor-definition'].some((kind) =>
    isAssignableToCanonicalType(node, kind, typeChecker, canonicalTypes),
  );
}

function isProcessorDefinitionClass(node, typeChecker, canonicalTypes) {
  const symbol = node.name === undefined ? undefined : typeChecker.getSymbolAtLocation(node.name);
  const instanceType =
    symbol === undefined
      ? typeChecker.getTypeAtLocation(node).getConstructSignatures()[0]?.getReturnType()
      : typeChecker.getDeclaredTypeOfSymbol(symbol);
  if (instanceType === undefined) return false;
  return ['processor-definition', 'batch-processor-definition'].some((kind) =>
    isTypeAssignableToCanonicalType(instanceType, kind, typeChecker, canonicalTypes),
  );
}

function isAssignableToCanonicalType(node, kind, typeChecker, canonicalTypes) {
  const sourceType = typeChecker.getTypeAtLocation(node);
  return isTypeAssignableToCanonicalType(sourceType, kind, typeChecker, canonicalTypes);
}

function isTypeAssignableToCanonicalType(sourceType, kind, typeChecker, canonicalTypes) {
  if (isUnprovableCompatibilityType(sourceType)) return false;
  for (const targetType of canonicalTypes.get(kind) ?? [])
    if (
      !isUnprovableCompatibilityType(targetType) &&
      typeChecker.isTypeAssignableTo(sourceType, targetType)
    )
      return true;
  return false;
}

function isUnprovableCompatibilityType(type) {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0;
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

function resolveProtectedKind(
  expression,
  bindings,
  typeChecker,
  sourceRoot,
  useNode = expression,
  seen = new Set(),
) {
  const unwrapped = unwrapExpression(expression);
  const aliasedAccessKind = resolveAliasedAccessKind(
    unwrapped,
    bindings,
    typeChecker,
    sourceRoot,
    useNode,
    seen,
  );
  if (aliasedAccessKind !== undefined) return aliasedAccessKind;
  const symbol = expressionSymbol(unwrapped, bindings, typeChecker);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const resolved = resolveSymbol(symbol, typeChecker);
  const kind = protectedSymbolKind(resolved, sourceRoot);
  if (kind !== undefined) return kind;
  const assignment =
    assignmentAt(bindings, symbol, useNode) ?? assignmentAt(bindings, resolved, useNode);
  return assignment === undefined
    ? undefined
    : resolveAssignmentOrigins(assignment, [], bindings, typeChecker, sourceRoot, useNode, seen);
}

function resolveAliasedAccessKind(expression, bindings, typeChecker, sourceRoot, useNode, seen) {
  const access = aliasedAccess(expression, bindings, typeChecker);
  if (access === undefined) return undefined;
  const symbol = typeChecker.getSymbolAtLocation(access.base);
  const resolved = resolveSymbol(symbol, typeChecker);
  const assignment =
    assignmentAt(bindings, symbol, useNode) ?? assignmentAt(bindings, resolved, useNode);
  if (symbol === undefined || assignment === undefined || seen.has(symbol)) return undefined;
  const branchSeen = new Set(seen);
  branchSeen.add(symbol);
  return resolveAssignmentOrigins(
    assignment,
    access.accessPath,
    bindings,
    typeChecker,
    sourceRoot,
    useNode,
    branchSeen,
  );
}

function aliasedAccess(expression, bindings, typeChecker) {
  const accessPath = [];
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      accessPath.unshift({ kind: 'property', name: current.name.text });
      current = unwrapExpression(current.expression);
      continue;
    }
    const selector = staticAccessSelector(current.argumentExpression, bindings, typeChecker);
    if (selector === undefined) return undefined;
    accessPath.unshift(selector);
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) && accessPath.length > 0
    ? { base: current, accessPath }
    : undefined;
}

function staticAccessSelector(node, bindings, typeChecker) {
  const expression = node === undefined ? undefined : unwrapExpression(node);
  if (expression !== undefined && ts.isNumericLiteral(expression)) {
    const index = Number(expression.text);
    return Number.isSafeInteger(index) && index >= 0 ? { kind: 'index', index } : undefined;
  }
  const name = staticString(expression, bindings, typeChecker);
  return name === undefined ? undefined : { kind: 'property', name };
}

function resolveAssignmentOrigins(
  assignment,
  appendedPath,
  bindings,
  typeChecker,
  sourceRoot,
  useNode,
  seen,
) {
  const parentKey = `assignment:${nodeId(assignment.sourceFile, bindings.analysis)}:${assignment.position}:${serializeAccessPath(appendedPath)}:${usePositionKey(useNode, bindings.analysis)}`;
  for (const origin of assignment.origins) {
    const path = [...origin.accessPath, ...appendedPath];
    const childKey = originStateKey(origin.expression, path, useNode, bindings.analysis);
    bindings.analysis.originEdges.add(`${parentKey}->${childKey}`);
    const kind = resolveAccessPathKind(
      origin.expression,
      path,
      bindings,
      typeChecker,
      sourceRoot,
      useNode,
      new Set(seen),
    );
    if (kind !== undefined) return kind;
  }
  return undefined;
}

function resolveAccessPathKind(
  expression,
  accessPath,
  bindings,
  typeChecker,
  sourceRoot,
  useNode,
  seen,
) {
  const stateKey = originStateKey(expression, accessPath, useNode, bindings.analysis);
  bindings.analysis.originStates.add(stateKey);
  if (bindings.analysis.memo.has(stateKey)) return bindings.analysis.memo.get(stateKey);
  bindings.analysis.memo.set(stateKey, undefined);
  const result = resolveAccessPathKindUncached(
    expression,
    accessPath,
    bindings,
    typeChecker,
    sourceRoot,
    useNode,
    seen,
  );
  bindings.analysis.memo.set(stateKey, result);
  return result;
}

function resolveAccessPathKindUncached(
  expression,
  accessPath,
  bindings,
  typeChecker,
  sourceRoot,
  useNode,
  seen,
) {
  if (accessPath.length === 0)
    return resolveProtectedKind(expression, bindings, typeChecker, sourceRoot, useNode, seen);
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const sourceSymbol = typeChecker.getSymbolAtLocation(unwrapped);
    const resolvedSource = resolveSymbol(sourceSymbol, typeChecker);
    const assignment =
      assignmentAt(bindings, sourceSymbol, useNode) ??
      assignmentAt(bindings, resolvedSource, useNode);
    if (sourceSymbol !== undefined && assignment !== undefined && !seen.has(sourceSymbol)) {
      const branchSeen = new Set(seen);
      branchSeen.add(sourceSymbol);
      return resolveAssignmentOrigins(
        assignment,
        accessPath,
        bindings,
        typeChecker,
        sourceRoot,
        useNode,
        branchSeen,
      );
    }
  }
  const access = aliasedAccess(unwrapped, bindings, typeChecker);
  if (access !== undefined) {
    const sourceSymbol = typeChecker.getSymbolAtLocation(access.base);
    const resolvedSource = resolveSymbol(sourceSymbol, typeChecker);
    const assignment =
      assignmentAt(bindings, sourceSymbol, useNode) ??
      assignmentAt(bindings, resolvedSource, useNode);
    if (sourceSymbol !== undefined && assignment !== undefined && !seen.has(sourceSymbol)) {
      const branchSeen = new Set(seen);
      branchSeen.add(sourceSymbol);
      return resolveAssignmentOrigins(
        assignment,
        [...access.accessPath, ...accessPath],
        bindings,
        typeChecker,
        sourceRoot,
        useNode,
        branchSeen,
      );
    }
  }
  const normalizedPath = normalizeRestAccess(accessPath);
  if (normalizedPath === undefined) return undefined;
  if (normalizedPath !== accessPath)
    return resolveAccessPathKind(
      unwrapped,
      normalizedPath,
      bindings,
      typeChecker,
      sourceRoot,
      useNode,
      seen,
    );
  const [head, ...tail] = accessPath;
  const selected = selectedLiteralExpression(unwrapped, head, bindings, typeChecker);
  if (selected !== undefined)
    return resolveAccessPathKind(selected, tail, bindings, typeChecker, sourceRoot, useNode, seen);
  const name = head.kind === 'property' ? head.name : String(head.index);
  const symbol = typeChecker.getTypeAtLocation(unwrapped).getProperty(name);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const resolved = resolveSymbol(symbol, typeChecker);
  const kind = protectedSymbolKind(resolved, sourceRoot);
  if (tail.length === 0 && kind !== undefined) return kind;
  const assignment =
    assignmentAt(bindings, symbol, useNode) ?? assignmentAt(bindings, resolved, useNode);
  return assignment === undefined
    ? undefined
    : resolveAssignmentOrigins(assignment, tail, bindings, typeChecker, sourceRoot, useNode, seen);
}

function originStateKey(expression, accessPath, useNode, analysis) {
  return `${nodeId(expression, analysis)}:${serializeAccessPath(accessPath)}:${usePositionKey(useNode, analysis)}`;
}

function usePositionKey(node, analysis) {
  const sourceFile = node.getSourceFile();
  return `${nodeId(sourceFile, analysis)}@${node.getStart(sourceFile)}`;
}

function nodeId(node, analysis) {
  let id = analysis.nodeIds.get(node);
  if (id === undefined) {
    id = analysis.nextNodeId;
    analysis.nextNodeId += 1;
    analysis.nodeIds.set(node, id);
  }
  return id;
}

function serializeAccessPath(accessPath) {
  return accessPath
    .map((selector) => {
      if (selector.kind === 'property') return `p:${selector.name}`;
      if (selector.kind === 'index') return `i:${selector.index}`;
      if (selector.kind === 'array-rest') return `ar:${selector.start}`;
      return `or:${selector.excluded.join(',')}`;
    })
    .join('/');
}

function normalizeRestAccess(accessPath) {
  const [head, next, ...tail] = accessPath;
  if (head.kind === 'array-rest') {
    if (next?.kind !== 'index') return undefined;
    return [{ kind: 'index', index: head.start + next.index }, ...tail];
  }
  if (head.kind === 'object-rest') {
    if (next?.kind !== 'property' || head.excluded.includes(next.name)) return undefined;
    return [next, ...tail];
  }
  return accessPath;
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
  if (isCanonicalObjectAssignSymbol(symbol)) return 'object-assign';
  for (const declaration of symbol.declarations ?? []) {
    const path = normalizeSourcePath(declaration.getSourceFile().fileName, sourceRoot);
    const name = symbol.name;
    if (eventingModulePathMatches(path, 'runtime/event-processor-host') && hostNames.has(name))
      return 'host';
    if (pathMatches(path, 'bootstrap/event-processor-runtime.ts') && registryNames.has(name))
      return 'registry';
    if (
      pathMatches(path, 'persistence/application/processor-run-serialiser.ts') &&
      serialiserNames.has(name)
    )
      return 'serialiser';
    if (
      eventingModulePathMatches(path, 'subscriptions/event-processor') &&
      processorFactoryNames.has(name)
    )
      return 'processor-factory';
    if (
      eventingModulePathMatches(path, 'subscriptions/event-processor') &&
      name === 'EventProcessorDefinition'
    )
      return 'processor-definition';
    if (
      eventingModulePathMatches(path, 'subscriptions/event-processor') &&
      name === 'BatchEventProcessorDefinition'
    )
      return 'batch-processor-definition';
    if (
      eventingModulePathMatches(path, 'projections/projection-processor') &&
      processorFactoryNames.has(name)
    )
      return 'processor-factory';
    if (eventingModulePathMatches(path, 'contracts/event-envelope') && name === 'createEventData')
      return 'event-data-factory';
    if (eventingModulePathMatches(path, 'contracts/events') && name === 'EventData')
      return 'event-data';
    if (eventingModulePathMatches(path, 'contracts/events') && name === 'EventEnvelope')
      return 'event-envelope';
    if (eventingModulePathMatches(path, 'contracts/event-schema') && name === 'decodeEventEnvelope')
      return 'event-envelope-decoder';
    if (eventingModulePathMatches(path, 'store/event-journal') && name === 'EventJournal')
      return 'event-journal';
  }
  return undefined;
}

function eventingModulePathMatches(path, modulePath) {
  return [
    `packages/eventing/src/${modulePath}.ts`,
    `packages/eventing/dist/${modulePath}.d.ts`,
    `node_modules/@atolis-hq/eventing/dist/${modulePath}.d.ts`,
  ].some((suffix) => pathMatches(path, suffix));
}

function isEventingPackagePath(path) {
  return (
    path.includes('/packages/eventing/src/') ||
    path.includes('/packages/eventing/dist/') ||
    path.includes('/node_modules/@atolis-hq/eventing/dist/')
  );
}

function isCanonicalObjectAssignSymbol(symbol) {
  if (symbol.name !== 'assign') return false;
  return (symbol.declarations ?? []).some(
    (declaration) =>
      ts.isMethodSignature(declaration) &&
      ts.isInterfaceDeclaration(declaration.parent) &&
      declaration.parent.name.text === 'ObjectConstructor' &&
      /\/typescript\/lib\/lib\.es2015\.core\.d\.ts$/u.test(
        normalizePath(declaration.getSourceFile().fileName),
      ),
  );
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
  const assignment = assignmentAt(bindings, symbol, node);
  if (assignment === undefined) return undefined;
  const values = [];
  for (const origin of assignment.origins) {
    const branchSeen = new Set(seen);
    const selected = selectAssignedExpression(
      origin.expression,
      origin.accessPath,
      bindings,
      typeChecker,
      node,
      branchSeen,
    );
    const value =
      selected === undefined
        ? undefined
        : staticString(selected, bindings, typeChecker, branchSeen);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

function selectAssignedExpression(expression, accessPath, bindings, typeChecker, useNode, seen) {
  if (accessPath.length === 0) return expression;
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const symbol = typeChecker.getSymbolAtLocation(unwrapped);
    const assignment = symbol === undefined ? undefined : assignmentAt(bindings, symbol, useNode);
    if (symbol !== undefined && assignment?.origins.length === 1 && !seen.has(symbol)) {
      seen.add(symbol);
      const [origin] = assignment.origins;
      return selectAssignedExpression(
        origin.expression,
        [...origin.accessPath, ...accessPath],
        bindings,
        typeChecker,
        useNode,
        seen,
      );
    }
  }
  const [head, ...tail] = accessPath;
  const selected = selectedLiteralExpression(unwrapped, head, bindings, typeChecker);
  return selected === undefined
    ? undefined
    : selectAssignedExpression(selected, tail, bindings, typeChecker, useNode, seen);
}

function addPersistenceDiagnostic(node, sourceRoot, diagnostics, reported) {
  const sourceFile = node.getSourceFile();
  const key = `${sourceFile.fileName}:${node.getStart(sourceFile)}`;
  if (reported.has(key)) return;
  reported.add(key);
  addDiagnostic(
    node,
    sourceRoot,
    'persistence-processor-handler',
    'persistence may not define handlers for Eventing processors',
    diagnostics,
  );
}

function addDiagnostic(node, sourceRoot, rule, detail, diagnostics) {
  const nodeSourceFile = node.getSourceFile();
  const { line, character } = nodeSourceFile.getLineAndCharacterOfPosition(
    node.getStart(nodeSourceFile),
  );
  const relativePath = normalizeSourcePath(nodeSourceFile.fileName, sourceRoot);
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
    else if (
      entry.isFile() &&
      /\.(?:cts|mts|tsx?)$/u.test(entry.name) &&
      !/\.d\.(?:cts|mts|ts)$/u.test(entry.name)
    )
      files.push(path);
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
