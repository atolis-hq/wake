import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const CONTRACT_VOCABULARY_RULES = [
  'closed-vocabulary',
  'event-literals',
  'stream-literals',
  'entity-ref',
  'erased-events',
  'payload-coercion',
];

const allRules = new Set(CONTRACT_VOCABULARY_RULES);
const domainModules = new Set(['work', 'resources', 'activities', 'orchestration', 'execution']);
const domainLayers = new Set(['domain', 'application']);

export async function checkContractVocabulary(root, options = {}) {
  const selectedRules = selectRules(options.rules);
  const { scanRoot, displayRoot } = await roots(root);
  const paths = await typeScriptFiles(scanRoot);
  const program = ts.createProgram(paths, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const sources = paths
    .map((path) => program.getSourceFile(path))
    .filter((source) => source !== undefined);
  const sourceDetails = sources.map((source) => ({
    source,
    path: normalizePath(relative(displayRoot, source.fileName)),
  }));
  const catalogues = collectCatalogues(sourceDetails, checker);
  const diagnostics = [];

  for (const detail of sourceDetails) {
    inspectSource(detail, catalogues, selectedRules, diagnostics, checker);
  }

  return diagnostics.sort(compareDiagnostics);
}

function selectRules(requested) {
  if (requested === undefined) return allRules;
  const selected = new Set(requested);
  const unknown = [...selected].filter((rule) => !allRules.has(rule));
  if (unknown.length > 0) {
    throw new Error(`Unknown contract-vocabulary rule: ${unknown.join(', ')}`);
  }
  return selected;
}

async function roots(root) {
  const requestedRoot = resolve(root);
  if (basename(requestedRoot).toLowerCase() === 'src-next') {
    return { scanRoot: requestedRoot, displayRoot: dirname(requestedRoot) };
  }
  const nestedSourceRoot = resolve(requestedRoot, 'src-next');
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
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

function collectCatalogues(sourceDetails, checker) {
  const eventValues = new Map();
  const streamValues = new Map();
  const closedValues = new Map();

  for (const { source, path } of sourceDetails) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;

      if (hasExportModifier(statement) && isContractPath(path, 'events.ts')) {
        collectNamedObject(statement, 'EventType', source, path, eventValues, checker);
      }
      if (hasExportModifier(statement) && isContractPath(path, 'streams.ts')) {
        collectNamedObject(statement, 'StreamKind', source, path, streamValues, checker);
      }
    }

    visit(source, (node) => {
      if (!isImportedKernelCall(checker, node, 'defineClosedVocabulary')) return;
      const argument = node.arguments[0];
      if (argument === undefined) return;
      const object = resolveObjectExpression(argument, checker, new Set());
      if (object === undefined) return;
      const owner = enclosingVariableName(node) ?? 'defineClosedVocabulary';
      for (const literal of valueLiterals(object)) {
        register(closedValues, literal.text, {
          owner,
          path,
          declarationStart: object.getStart(source),
          declarationEnd: object.getEnd(),
        });
      }
    });
  }

  return { eventValues, streamValues, closedValues };
}

function collectNamedObject(statement, suffix, source, path, registrations, checker) {
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith(suffix)) continue;
    if (declaration.initializer === undefined) continue;
    const object = catalogueObject(declaration.initializer, checker);
    if (object === undefined) continue;
    for (const literal of valueLiterals(object)) {
      register(registrations, literal.text, {
        owner: declaration.name.text,
        path,
        declarationStart: object.getStart(source),
        declarationEnd: object.getEnd(),
      });
    }
  }
}

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function isContractPath(path, fileName) {
  const parts = path.toLowerCase().split('/');
  return parts.at(-2) === 'contracts' && parts.at(-1) === fileName;
}

function catalogueObject(expression, checker) {
  const object = resolveObjectExpression(expression, checker, new Set());
  if (object !== undefined) return object;
  const unwrapped = unwrapExpression(expression);
  if (isImportedKernelCall(checker, unwrapped, 'defineClosedVocabulary')) {
    const argument = unwrapped.arguments[0];
    if (argument !== undefined) return resolveObjectExpression(argument, checker, new Set());
  }
  return undefined;
}

function resolveObjectExpression(expression, checker, visited) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (symbol === undefined || visited.has(symbol)) return undefined;
  visited.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      !isConstDeclaration(declaration)
    ) {
      continue;
    }
    const object = resolveObjectExpression(declaration.initializer, checker, visited);
    if (object !== undefined) return object;
  }
  return undefined;
}

function isConstDeclaration(declaration) {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function valueLiterals(expression) {
  const literals = [];
  if (!ts.isObjectLiteralExpression(expression)) return literals;

  for (const property of expression.properties) {
    if (ts.isPropertyAssignment(property)) {
      collectExpressionLiterals(property.initializer, literals);
    }
  }
  return literals;
}

function collectExpressionLiterals(node, literals) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    literals.push(node);
    return;
  }
  node.forEachChild((child) => collectExpressionLiterals(child, literals));
}

function register(registrations, value, registration) {
  const existing = registrations.get(value);
  if (existing === undefined) {
    registrations.set(value, [registration]);
  } else if (
    !existing.some(
      (entry) =>
        entry.owner === registration.owner &&
        entry.path === registration.path &&
        entry.declarationStart === registration.declarationStart &&
        entry.declarationEnd === registration.declarationEnd,
    )
  ) {
    existing.push(registration);
  }
}

function enclosingVariableName(node) {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

function inspectSource(detail, catalogues, rules, diagnostics, checker) {
  const { source, path } = detail;
  if (path.toLowerCase().endsWith('.corrupt-fixture.ts')) return;
  const provenance = collectEventProvenance(source, checker);

  visit(source, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      inspectLiteral(detail, node, catalogues, rules, diagnostics);
    }
    if (
      rules.has('entity-ref') &&
      ts.isCallExpression(node) &&
      isImportedKernelCall(checker, node, 'entityRef') &&
      !allowsEntityRef(path)
    ) {
      addDiagnostic(
        diagnostics,
        detail,
        node,
        'entity-ref',
        'entityRef(...)',
        streamContractFor(path),
      );
    }
    if (rules.has('erased-events') && isDomainCode(path) && ts.isTypeReferenceNode(node)) {
      inspectEventType(detail, node, checker, diagnostics);
    }
    if (
      rules.has('payload-coercion') &&
      isDomainCode(path) &&
      ts.isCallExpression(node) &&
      isPayloadCoercion(node, checker, provenance)
    ) {
      const coercion = callName(node);
      addDiagnostic(
        diagnostics,
        detail,
        node,
        'payload-coercion',
        `${coercion}(payload.*)`,
        'typed payload from EventUnion/EventDraftUnion',
      );
    }
  });
}

function inspectLiteral(detail, literal, catalogues, rules, diagnostics) {
  const { path } = detail;
  if (allowsProviderValue(path, literal) || isPrivatePersistenceKey(path, literal)) return;
  const value = literal.text;

  if (rules.has('closed-vocabulary')) {
    for (const registration of catalogues.closedValues.get(value) ?? []) {
      if (!isInsideRegistration(detail, literal, registration)) {
        addDiagnostic(diagnostics, detail, literal, 'closed-vocabulary', value, registration.owner);
      }
    }
  }

  if (rules.has('event-literals')) {
    for (const registration of catalogues.eventValues.get(value) ?? []) {
      if (!isInsideRegistration(detail, literal, registration)) {
        addDiagnostic(diagnostics, detail, literal, 'event-literals', value, registration.owner);
      }
    }
  }

  if (rules.has('stream-literals')) {
    for (const registration of catalogues.streamValues.get(value) ?? []) {
      if (!isInsideRegistration(detail, literal, registration)) {
        addDiagnostic(diagnostics, detail, literal, 'stream-literals', value, registration.owner);
      }
    }
  }
}

function isInsideRegistration(detail, literal, registration) {
  const position = literal.getStart(detail.source);
  return (
    detail.path === registration.path &&
    position >= registration.declarationStart &&
    position < registration.declarationEnd
  );
}

function allowsProviderValue(path, literal) {
  const parts = path.toLowerCase().split('/');
  if (parts.some(isDecoderFixturePart)) return true;
  if (!parts.includes('integrations')) return false;
  return parts.some(isDecoderPathPart) || hasDecoderFunctionAncestor(literal);
}

function isDecoderFixturePart(part) {
  return part === 'decoder-fixtures' || part.endsWith('.decoder-fixture.ts');
}

function isDecoderPathPart(part) {
  return (
    isNamedBoundaryFile(part, 'decoder') ||
    isNamedBoundaryFile(part, 'translator') ||
    isNamedBoundaryFile(part, 'translation') ||
    isNamedBoundaryFile(part, 'parser')
  );
}

function isNamedBoundaryFile(part, boundary) {
  return part.startsWith(`${boundary}.`) || part.includes(`-${boundary}.`);
}

function hasDecoderFunctionAncestor(node) {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && isDecoderName(current.name)) return true;
    if (ts.isMethodDeclaration(current) && isDecoderName(current.name)) return true;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      isDecoderName(current.parent.name)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isDecoderName(name) {
  if (!ts.isIdentifier(name)) return false;
  const normalized = name.text.toLowerCase();
  return (
    normalized.startsWith('decodeprovider') ||
    normalized.startsWith('translateprovider') ||
    normalized.startsWith('parseprovider')
  );
}

function isPrivatePersistenceKey(path, literal) {
  if (!path.toLowerCase().split('/').includes('persistence')) return false;
  const { parent } = literal;
  return (
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === literal) ||
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === literal)
  );
}

function allowsEntityRef(path) {
  const parts = path.toLowerCase().split('/');
  const isIdentifierContract =
    parts.at(-3) === 'kernel' && parts.at(-2) === 'contracts' && parts.at(-1) === 'identifiers.ts';
  return isIdentifierContract || isContractPath(path, 'streams.ts');
}

function streamContractFor(path) {
  const parts = path.split('/');
  const sourceIndex = parts.findIndex((part) => part.toLowerCase() === 'src-next');
  const moduleName = parts[sourceIndex === -1 ? 0 : sourceIndex + 1] ?? '<module>';
  return `${moduleName}/contracts/streams.ts`;
}

function isDomainCode(path) {
  const parts = path.toLowerCase().split('/');
  const sourceIndex = parts.indexOf('src-next');
  const moduleIndex = sourceIndex === -1 ? 0 : sourceIndex + 1;
  return domainModules.has(parts[moduleIndex]) && domainLayers.has(parts[moduleIndex + 1]);
}

function inspectEventType(detail, node, checker, diagnostics) {
  const name = importedEventContractName(checker, node.typeName);
  if (name === undefined) return;
  const typeArguments = node.typeArguments ?? [];
  if (
    typeArguments.length >= 3 &&
    isUsefulContractType(typeArguments[0], checker, new Set()) &&
    isUsefulContractType(typeArguments[1], checker, new Set()) &&
    isUsefulStreamType(typeArguments[2], checker, new Set())
  ) {
    return;
  }
  addDiagnostic(
    diagnostics,
    detail,
    node,
    'erased-events',
    node.getText(detail.source),
    name === 'EventDraft' ? 'EventDraftUnion' : 'EventUnion',
  );
}

function importedEventContractName(checker, node) {
  if (isImportedKernelReference(checker, node, 'EventDraft')) return 'EventDraft';
  if (isImportedKernelReference(checker, node, 'EventEnvelope')) return 'EventEnvelope';
  return undefined;
}

function isUsefulContractType(node, checker, visited) {
  if (isErasedKeyword(node)) return false;
  if (!ts.isTypeReferenceNode(node)) return true;
  const alias = resolvedTypeAlias(checker, node.typeName);
  if (alias === undefined || visited.has(alias.symbol)) return true;
  visited.add(alias.symbol);
  return isUsefulContractType(alias.declaration.type, checker, visited);
}

function isUsefulStreamType(node, checker, visited) {
  if (isErasedKeyword(node) || !ts.isTypeReferenceNode(node)) return false;
  if (isImportedKernelReference(checker, node.typeName, 'EntityRef')) {
    const typeArguments = node.typeArguments ?? [];
    return (
      typeArguments.length === 2 &&
      isExactStringLiteralType(typeArguments[0], checker) &&
      isBrandedStringType(typeArguments[1], checker, new Set())
    );
  }
  const alias = resolvedTypeAlias(checker, node.typeName);
  if (alias === undefined || visited.has(alias.symbol)) return false;
  visited.add(alias.symbol);
  return isUsefulStreamType(alias.declaration.type, checker, visited);
}

function isExactStringLiteralType(node, checker) {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return true;
  const type = checker.getTypeFromTypeNode(node);
  return (type.flags & ts.TypeFlags.StringLiteral) !== 0;
}

function isBrandedStringType(node, checker, visited) {
  if (isErasedKeyword(node)) return false;
  if (ts.isIntersectionTypeNode(node)) {
    const explicitlyBranded =
      node.types.some((part) => part.kind === ts.SyntaxKind.StringKeyword) &&
      node.types.some((part) => part.kind !== ts.SyntaxKind.StringKeyword);
    if (explicitlyBranded) return true;
  }
  const type = checker.getTypeFromTypeNode(node);
  if (
    (type.flags & ts.TypeFlags.Intersection) !== 0 &&
    type.types.some((part) => (part.flags & ts.TypeFlags.StringLike) !== 0) &&
    type.types.some((part) => (part.flags & ts.TypeFlags.Object) !== 0)
  ) {
    return true;
  }
  if (!ts.isTypeReferenceNode(node)) return false;
  const alias = resolvedTypeAlias(checker, node.typeName);
  if (alias !== undefined && !visited.has(alias.symbol)) {
    visited.add(alias.symbol);
    return isBrandedStringType(alias.declaration.type, checker, visited);
  }
  return false;
}

function isErasedKeyword(node) {
  return (
    node.kind === ts.SyntaxKind.AnyKeyword ||
    node.kind === ts.SyntaxKind.UnknownKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword
  );
}

function resolvedTypeAlias(checker, node) {
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node));
  const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
  return declaration === undefined ? undefined : { symbol, declaration };
}

function resolvedSymbol(checker, symbol) {
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function isPayloadCoercion(node, checker, provenance) {
  const name = callName(node);
  const argument = node.arguments[0];
  return (
    (name === 'String' || name === 'Number') &&
    argument !== undefined &&
    isGlobalBuiltinReference(checker, node.expression) &&
    isProvenPayloadExpression(argument, checker, provenance)
  );
}

function callName(node) {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  return undefined;
}

function collectEventProvenance(source, checker) {
  const eventSymbols = new Set();
  const payloadSymbols = new Set();
  const declarations = [];
  visit(source, (node) => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
      declarations.push(node);
      if (
        ts.isIdentifier(node.name) &&
        node.type !== undefined &&
        isEventTypeNode(node.type, checker, new Set())
      ) {
        addNodeSymbol(eventSymbols, checker, node.name);
      }
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const initializer = declaration.initializer;
      if (initializer === undefined) continue;
      if (ts.isIdentifier(declaration.name)) {
        const symbol = checker.getSymbolAtLocation(declaration.name);
        if (
          symbol !== undefined &&
          !eventSymbols.has(symbol) &&
          isProvenEventExpression(initializer, checker, eventSymbols)
        ) {
          eventSymbols.add(symbol);
          changed = true;
        }
        if (
          symbol !== undefined &&
          !payloadSymbols.has(symbol) &&
          isProvenPayloadExpression(initializer, checker, { eventSymbols, payloadSymbols })
        ) {
          payloadSymbols.add(symbol);
          changed = true;
        }
        continue;
      }
      if (
        ts.isObjectBindingPattern(declaration.name) &&
        isProvenEventExpression(initializer, checker, eventSymbols)
      ) {
        for (const element of declaration.name.elements) {
          const sourceName = element.propertyName ?? element.name;
          if (bindingNameText(sourceName) !== 'payload') continue;
          for (const identifier of bindingIdentifiers(element.name)) {
            changed = addNodeSymbol(payloadSymbols, checker, identifier) || changed;
          }
        }
      }
    }
  }
  return { eventSymbols, payloadSymbols };
}

function isEventTypeNode(node, checker, visited) {
  if (ts.isParenthesizedTypeNode(node)) return isEventTypeNode(node.type, checker, visited);
  if (ts.isUnionTypeNode(node)) {
    return node.types.some((part) => isEventTypeNode(part, checker, new Set(visited)));
  }
  if (!ts.isTypeReferenceNode(node)) return false;
  if (
    isImportedKernelReference(checker, node.typeName, 'EventDraft') ||
    isImportedKernelReference(checker, node.typeName, 'EventEnvelope')
  ) {
    return true;
  }
  const alias = resolvedTypeAlias(checker, node.typeName);
  if (alias === undefined || visited.has(alias.symbol)) return false;
  visited.add(alias.symbol);
  return isEventTypeNode(alias.declaration.type, checker, visited);
}

function isProvenEventExpression(expression, checker, eventSymbols) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  return symbol !== undefined && eventSymbols.has(symbol);
}

function isProvenPayloadExpression(expression, checker, provenance) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const symbol = checker.getSymbolAtLocation(unwrapped);
    return symbol !== undefined && provenance.payloadSymbols.has(symbol);
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    if (propertyName(unwrapped) === 'payload') {
      return isProvenEventExpression(unwrapped.expression, checker, provenance.eventSymbols);
    }
    return isProvenPayloadExpression(unwrapped.expression, checker, provenance);
  }
  return false;
}

function propertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  const argument = expression.argumentExpression;
  return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
    ? argument.text
    : undefined;
}

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
}

function bindingNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function addNodeSymbol(symbols, checker, node) {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined || symbols.has(symbol)) return false;
  symbols.add(symbol);
  return true;
}

function isKernelModule(moduleSpecifier) {
  return moduleSpecifier.replaceAll('\\', '/').split('/').includes('kernel');
}

function isImportedKernelCall(checker, node, exportedName) {
  return (
    ts.isCallExpression(node) && isImportedKernelReference(checker, node.expression, exportedName)
  );
}

function isImportedKernelReference(checker, node, exportedName) {
  if (ts.isIdentifier(node)) {
    return symbolIsKernelImport(checker.getSymbolAtLocation(node), exportedName);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return (
      node.name.text === exportedName &&
      symbolIsKernelNamespace(checker.getSymbolAtLocation(node.expression))
    );
  }
  if (ts.isQualifiedName(node)) {
    return (
      node.right.text === exportedName &&
      symbolIsKernelNamespace(checker.getSymbolAtLocation(node.left))
    );
  }
  return false;
}

function symbolIsKernelImport(symbol, exportedName) {
  return (symbol?.declarations ?? []).some((declaration) => {
    if (!ts.isImportSpecifier(declaration)) return false;
    const importedName = declaration.propertyName?.text ?? declaration.name.text;
    const importNode = enclosingImportDeclaration(declaration);
    return (
      importedName === exportedName &&
      importNode !== undefined &&
      ts.isStringLiteral(importNode.moduleSpecifier) &&
      isKernelModule(importNode.moduleSpecifier.text)
    );
  });
}

function symbolIsKernelNamespace(symbol) {
  return (symbol?.declarations ?? []).some((declaration) => {
    if (!ts.isNamespaceImport(declaration)) return false;
    const importNode = enclosingImportDeclaration(declaration);
    return (
      importNode !== undefined &&
      ts.isStringLiteral(importNode.moduleSpecifier) &&
      isKernelModule(importNode.moduleSpecifier.text)
    );
  });
}

function enclosingImportDeclaration(node) {
  let current = node.parent;
  while (current !== undefined && !ts.isImportDeclaration(current)) current = current.parent;
  return current;
}

function isGlobalBuiltinReference(checker, node) {
  if (!ts.isIdentifier(node)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return true;
  const declarations = symbol.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      const source = declaration.getSourceFile();
      const path = normalizePath(source.fileName).toLowerCase();
      return source.isDeclarationFile && path.includes('/typescript/lib/lib.');
    })
  );
}

function visit(node, visitor) {
  visitor(node);
  node.forEachChild((child) => visit(child, visitor));
}

function addDiagnostic(diagnostics, detail, node, rule, value, owner) {
  const position = node.getStart(detail.source);
  const { line, character } = detail.source.getLineAndCharacterOfPosition(position);
  const diagnostic = {
    rule,
    path: detail.path,
    line: line + 1,
    column: character + 1,
    position,
    value,
    owner,
  };
  diagnostics.push({
    ...diagnostic,
    message: `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} [${rule}] "${value}" must be replaced by ${owner}`,
  });
}

function compareDiagnostics(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.position - right.position ||
    left.rule.localeCompare(right.rule) ||
    left.owner.localeCompare(right.owner)
  );
}
