import { readFile, readdir, stat } from 'node:fs/promises';
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
  const sources = await Promise.all(
    paths.map(async (path) =>
      ts.createSourceFile(
        path,
        await readFile(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      ),
    ),
  );
  const sourceDetails = sources.map((source) => ({
    source,
    path: normalizePath(relative(displayRoot, source.fileName)),
  }));
  const catalogues = collectCatalogues(sourceDetails);
  const diagnostics = [];

  for (const detail of sourceDetails) {
    inspectSource(detail, catalogues, selectedRules, diagnostics);
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

function collectCatalogues(sourceDetails) {
  const eventValues = new Map();
  const streamValues = new Map();
  const closedValues = new Map();

  for (const { source, path } of sourceDetails) {
    const defineVocabularyBindings = kernelBindings(source, 'defineClosedVocabulary');
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;

      if (hasExportModifier(statement) && isContractPath(path, 'events.ts')) {
        collectNamedObject(
          statement,
          'EventType',
          source,
          path,
          eventValues,
          defineVocabularyBindings,
        );
      }
      if (hasExportModifier(statement) && isContractPath(path, 'streams.ts')) {
        collectNamedObject(
          statement,
          'StreamKind',
          source,
          path,
          streamValues,
          defineVocabularyBindings,
        );
      }
    }

    visit(source, (node) => {
      if (!isBoundCall(node, defineVocabularyBindings)) return;
      const argument = node.arguments[0];
      if (argument === undefined) return;
      const owner = enclosingVariableName(node) ?? 'defineClosedVocabulary';
      for (const literal of valueLiterals(unwrapExpression(argument))) {
        register(closedValues, literal.text, {
          owner,
          path,
          declarationStart: argument.getStart(source),
          declarationEnd: argument.getEnd(),
        });
      }
    });
  }

  return { eventValues, streamValues, closedValues };
}

function collectNamedObject(
  statement,
  suffix,
  source,
  path,
  registrations,
  defineVocabularyBindings,
) {
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith(suffix)) continue;
    if (declaration.initializer === undefined) continue;
    const object = catalogueObject(declaration.initializer, defineVocabularyBindings);
    if (object === undefined) continue;
    for (const literal of valueLiterals(object)) {
      register(registrations, literal.text, {
        owner: declaration.name.text,
        path,
        declarationStart: declaration.getStart(source),
        declarationEnd: declaration.getEnd(),
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

function catalogueObject(expression, defineVocabularyBindings) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
  if (isBoundCall(unwrapped, defineVocabularyBindings)) {
    const argument = unwrapped.arguments[0];
    if (argument !== undefined) {
      const object = unwrapExpression(argument);
      if (ts.isObjectLiteralExpression(object)) return object;
    }
  }
  return undefined;
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

function inspectSource(detail, catalogues, rules, diagnostics) {
  const { source, path } = detail;
  if (path.toLowerCase().endsWith('.corrupt-fixture.ts')) return;
  const bindings = {
    entityRef: kernelBindings(source, 'entityRef'),
    eventDraft: kernelBindings(source, 'EventDraft'),
    eventEnvelope: kernelBindings(source, 'EventEnvelope'),
  };

  visit(source, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      inspectLiteral(detail, node, catalogues, rules, diagnostics);
    }
    if (
      rules.has('entity-ref') &&
      ts.isCallExpression(node) &&
      isBoundCall(node, bindings.entityRef) &&
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
      inspectEventType(detail, node, bindings, diagnostics);
    }
    if (
      rules.has('payload-coercion') &&
      isDomainCode(path) &&
      ts.isCallExpression(node) &&
      isPayloadCoercion(node)
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
      const position = literal.getStart(detail.source);
      const insideDeclaration =
        path === registration.path &&
        position >= registration.declarationStart &&
        position < registration.declarationEnd;
      if (!insideDeclaration) {
        addDiagnostic(diagnostics, detail, literal, 'closed-vocabulary', value, registration.owner);
      }
    }
  }

  if (rules.has('event-literals')) {
    for (const registration of catalogues.eventValues.get(value) ?? []) {
      if (path !== registration.path) {
        addDiagnostic(diagnostics, detail, literal, 'event-literals', value, registration.owner);
      }
    }
  }

  if (rules.has('stream-literals')) {
    for (const registration of catalogues.streamValues.get(value) ?? []) {
      if (path !== registration.path) {
        addDiagnostic(diagnostics, detail, literal, 'stream-literals', value, registration.owner);
      }
    }
  }
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
  return part === 'decoders' || part.includes('decoder.');
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
  return ts.isIdentifier(name) && name.text.toLowerCase().includes('decode');
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

function inspectEventType(detail, node, bindings, diagnostics) {
  const name = boundEventType(node.typeName, bindings);
  if (name === undefined) return;
  const typeArguments = node.typeArguments ?? [];
  if (
    typeArguments.length >= 2 &&
    !isErasedTypeArgument(typeArguments[0], true) &&
    !isErasedTypeArgument(typeArguments[1], false)
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

function boundEventType(typeName, bindings) {
  if (isBoundReference(typeName, bindings.eventDraft)) return 'EventDraft';
  if (isBoundReference(typeName, bindings.eventEnvelope)) return 'EventEnvelope';
  return undefined;
}

function isErasedTypeArgument(node, isEventType) {
  return (
    node?.kind === ts.SyntaxKind.AnyKeyword ||
    node?.kind === ts.SyntaxKind.UnknownKeyword ||
    (isEventType && node?.kind === ts.SyntaxKind.StringKeyword)
  );
}

function isPayloadCoercion(node) {
  const name = callName(node);
  const argument = node.arguments[0];
  return (
    (name === 'String' || name === 'Number') && argument !== undefined && isPayloadAccess(argument)
  );
}

function callName(node) {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  return undefined;
}

function isPayloadAccess(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    if (propertyName(unwrapped) === 'payload') return true;
    const owner = unwrapExpression(unwrapped.expression);
    return ts.isIdentifier(owner) ? owner.text === 'payload' : isPayloadAccess(owner);
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

function kernelBindings(source, exportedName) {
  const identifiers = new Set();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isKernelModule(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === exportedName) identifiers.add(element.name.text);
    }
  }
  return { exportedName, identifiers, namespaces };
}

function isKernelModule(moduleSpecifier) {
  return moduleSpecifier.replaceAll('\\', '/').split('/').includes('kernel');
}

function isBoundCall(node, bindings) {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return bindings.identifiers.has(expression.text);
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === bindings.exportedName &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text)
  );
}

function isBoundReference(typeName, bindings) {
  if (ts.isIdentifier(typeName)) return bindings.identifiers.has(typeName.text);
  return (
    typeName.right.text === bindings.exportedName &&
    ts.isIdentifier(typeName.left) &&
    bindings.namespaces.has(typeName.left.text)
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
