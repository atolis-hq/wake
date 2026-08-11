import ts from 'typescript';
import { createShapeDiagnostic } from './contract-vocabulary-rules.mjs';

export function discoverCatalogues(sourceDetails, rules) {
  const catalogues = {
    closedValues: new Map(),
    eventValues: new Map(),
    streamValues: new Map(),
  };
  const diagnostics = [];

  for (const detail of sourceDetails) {
    if (isEventContractPath(detail.path)) {
      discoverNamedCatalogues(
        detail,
        'EventType',
        'event-literals',
        catalogues.eventValues,
        diagnosticsFor(rules, diagnostics, 'event-literals'),
      );
    }
    if (isCanonicalModuleContractPath(detail.path, 'streams.ts')) {
      discoverNamedCatalogues(
        detail,
        'StreamKind',
        'stream-literals',
        catalogues.streamValues,
        diagnosticsFor(rules, diagnostics, 'stream-literals'),
        true,
      );
    } else if (rules.has('stream-literals')) {
      rejectOffPathCatalogues(detail, 'StreamKind', 'stream-literals', diagnostics);
    }
    discoverClosedCatalogues(
      detail,
      catalogues.closedValues,
      diagnosticsFor(rules, diagnostics, 'closed-vocabulary'),
    );
  }

  return { catalogues, diagnostics };
}

function diagnosticsFor(rules, diagnostics, rule) {
  return rules.has(rule) ? diagnostics : [];
}

function rejectOffPathCatalogues(detail, suffix, rule, diagnostics) {
  for (const statement of detail.source.statements) {
    if (ts.isVariableStatement(statement)) {
      const exported =
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false;
      if (!exported) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith(suffix)) continue;
        rejectShape(
          diagnostics,
          detail,
          declaration.name,
          rule,
          declaration.name.text,
          `${declaration.name.text} must be declared in contracts/streams.ts`,
        );
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) continue;
    if (ts.isNamespaceExport(statement.exportClause)) {
      const owner = statement.exportClause.name.text;
      if (owner.endsWith(suffix)) {
        rejectShape(
          diagnostics,
          detail,
          statement.exportClause.name,
          rule,
          owner,
          `${owner} must be declared in contracts/streams.ts`,
        );
      }
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const specifier of statement.exportClause.elements) {
      const owner = specifier.name.text;
      if (!owner.endsWith(suffix)) continue;
      rejectShape(
        diagnostics,
        detail,
        specifier.name,
        rule,
        owner,
        `${owner} must be declared in contracts/streams.ts`,
      );
    }
  }
}

function discoverNamedCatalogues(
  detail,
  suffix,
  rule,
  registrations,
  diagnostics,
  requireSingle = false,
) {
  const localNames = new Set();
  const declarations = [];

  for (const statement of detail.source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith(suffix)) {
        continue;
      }
      localNames.add(declaration.name.text);
      declarations.push(declaration);
      discoverNamedCatalogue(detail, statement, declaration, rule, registrations, diagnostics);
    }
  }

  if (requireSingle && declarations.length > 1) {
    const canonicalOwner = declarations[0].name.text;
    for (const declaration of declarations.slice(1)) {
      const owner = declaration.name.text;
      rejectShape(
        diagnostics,
        detail,
        declaration.name,
        rule,
        owner,
        `${owner} duplicates ${canonicalOwner}; contracts/streams.ts must declare exactly one ${suffix} catalogue`,
      );
    }
  }

  rejectIndirectExports(detail, suffix, rule, localNames, diagnostics);
}

function discoverNamedCatalogue(detail, statement, declaration, rule, registrations, diagnostics) {
  const owner = declaration.name.text;
  if (!isExportedConst(statement)) {
    rejectShape(
      diagnostics,
      detail,
      declaration.name,
      rule,
      owner,
      `${owner} must be declared directly with export const`,
    );
    return;
  }
  if (declaration.initializer === undefined) {
    rejectShape(
      diagnostics,
      detail,
      declaration.name,
      rule,
      owner,
      `${owner} must use an inline object initializer`,
    );
    return;
  }

  const object = constAssertedObject(declaration.initializer);
  if (object === undefined) {
    const unwrapped = unwrapExpression(declaration.initializer);
    const reason = ts.isObjectLiteralExpression(unwrapped)
      ? `${owner} inline object initializer must use as const`
      : `${owner} must use an inline object initializer`;
    rejectShape(diagnostics, detail, declaration.initializer, rule, owner, reason);
    return;
  }
  registerObject(detail, object, declaration.initializer, rule, owner, registrations, diagnostics);
}

function rejectIndirectExports(detail, suffix, rule, localNames, diagnostics) {
  for (const statement of detail.source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.exportClause === undefined) {
      rejectShape(
        diagnostics,
        detail,
        statement,
        rule,
        suffix,
        `${suffix} catalogues must not use wildcard exports`,
      );
      continue;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      const owner = statement.exportClause.name.text;
      if (owner.endsWith(suffix)) {
        rejectShape(
          diagnostics,
          detail,
          statement.exportClause,
          rule,
          owner,
          `${owner} must be declared directly with export const`,
        );
      }
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const specifier of statement.exportClause.elements) {
      const owner = specifier.name.text;
      const localName = specifier.propertyName?.text ?? owner;
      if (!owner.endsWith(suffix) || localNames.has(localName)) continue;
      rejectShape(
        diagnostics,
        detail,
        specifier,
        rule,
        owner,
        `${owner} must be declared directly with export const`,
      );
    }
  }
}

function discoverClosedCatalogues(detail, registrations, diagnostics) {
  const imports = closedVocabularyImports(detail.source);
  visit(detail.source, (node) => {
    if (isDefineClosedVocabularyCall(node)) {
      discoverClosedCatalogue(detail, node, registrations, diagnostics);
    } else if (isUnsupportedClosedVocabularyCall(node, imports)) {
      rejectClosedVocabularySpelling(detail, node, diagnostics);
    }
  });
}

function discoverClosedCatalogue(detail, call, registrations, diagnostics) {
  const declaration = enclosingVariableDeclaration(call);
  const owner = variableName(declaration) ?? 'defineClosedVocabulary';
  const statement = variableStatement(declaration);
  if (
    declaration === undefined ||
    statement === undefined ||
    statement.parent !== detail.source ||
    !isExportedConst(statement)
  ) {
    rejectShape(
      diagnostics,
      detail,
      declaration?.name ?? call,
      'closed-vocabulary',
      owner,
      `${owner} must be declared directly with export const`,
    );
    return;
  }
  if (unwrapParentheses(declaration.initializer) !== call) {
    rejectShape(
      diagnostics,
      detail,
      call,
      'closed-vocabulary',
      owner,
      `${owner} must use defineClosedVocabulary(...) as its direct initializer`,
    );
    return;
  }
  if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0])) {
    rejectShape(
      diagnostics,
      detail,
      call,
      'closed-vocabulary',
      owner,
      `${owner} must pass exactly one inline object literal as const`,
    );
    return;
  }

  const argument = unwrapParentheses(call.arguments[0]);
  if (!isConstAssertion(argument)) {
    const unwrapped = unwrapExpression(argument);
    const reason = ts.isObjectLiteralExpression(unwrapped)
      ? `${owner} inline object argument must use as const`
      : `${owner} must pass an inline object literal as const`;
    rejectShape(diagnostics, detail, argument, 'closed-vocabulary', owner, reason);
    return;
  }

  const object = inlineObject(argument.expression);
  if (object === undefined) {
    rejectShape(
      diagnostics,
      detail,
      argument,
      'closed-vocabulary',
      owner,
      `${owner} must pass an inline object literal as const`,
    );
    return;
  }
  registerObject(detail, object, call, 'closed-vocabulary', owner, registrations, diagnostics);
}

function registerObject(detail, object, initializer, rule, owner, registrations, diagnostics) {
  const entries = [];
  const shapeDiagnostics = [];

  for (const property of object.properties) {
    const issue = propertyIssue(property, owner);
    if (issue !== undefined) {
      shapeDiagnostics.push(createShapeDiagnostic(detail, property, rule, owner, issue));
    } else {
      entries.push(property.initializer);
    }
  }

  if (shapeDiagnostics.length > 0) {
    diagnostics.push(...shapeDiagnostics);
    return;
  }
  for (const literal of entries) {
    const start = literal.getStart(detail.source);
    const { line, character } = detail.source.getLineAndCharacterOfPosition(start);
    register(registrations, literal.text, {
      owner,
      path: detail.path,
      line: line + 1,
      column: character + 1,
      initializerStart: initializer.getStart(detail.source),
      initializerEnd: initializer.getEnd(),
    });
  }
}

function propertyIssue(property, owner) {
  if (ts.isSpreadAssignment(property)) return `${owner} contains a spread property`;
  if (ts.isShorthandPropertyAssignment(property)) {
    return `${owner} contains a shorthand property`;
  }
  if (!ts.isPropertyAssignment(property)) {
    return `${owner} contains an unsupported property declaration`;
  }
  if (ts.isComputedPropertyName(property.name)) {
    return `${owner} contains a computed property`;
  }
  if (!ts.isStringLiteral(property.initializer)) {
    return `${owner}.${propertyName(property.name)} must have a string-literal value`;
  }
  return undefined;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return '<property>';
}

function register(registrations, value, registration) {
  const existing = registrations.get(value);
  if (existing === undefined) {
    registrations.set(value, [registration]);
  } else {
    existing.push(registration);
  }
}

function rejectShape(diagnostics, detail, node, rule, owner, reason) {
  diagnostics.push(createShapeDiagnostic(detail, node, rule, owner, reason));
}

function constAssertedObject(expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return isConstAssertion(current) ? inlineObject(current.expression) : undefined;
}

function inlineObject(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isObjectLiteralExpression(unwrapped) ? unwrapped : undefined;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function unwrapParentheses(expression) {
  let current = expression;
  while (current !== undefined && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isConstAssertion(expression) {
  return (
    ts.isAsExpression(expression) &&
    ts.isTypeReferenceNode(expression.type) &&
    ts.isIdentifier(expression.type.typeName) &&
    expression.type.typeName.text === 'const'
  );
}

function isDefineClosedVocabularyCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrapParentheses(node.expression);
  return (
    callee !== undefined && ts.isIdentifier(callee) && callee.text === 'defineClosedVocabulary'
  );
}

function closedVocabularyImports(source) {
  const aliases = new Set();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const specifier of bindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (
        importedName === 'defineClosedVocabulary' &&
        specifier.name.text !== 'defineClosedVocabulary'
      ) {
        aliases.add(specifier.name.text);
      }
    }
  }
  return { aliases, namespaces };
}

function isUnsupportedClosedVocabularyCall(node, imports) {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrapParentheses(node.expression);
  if (callee === undefined) return false;
  if (ts.isIdentifier(callee)) return imports.aliases.has(callee.text);
  if (
    ts.isPropertyAccessExpression(callee) &&
    isImportedNamespaceReceiver(callee.expression, imports)
  ) {
    return callee.name.text === 'defineClosedVocabulary';
  }
  return (
    ts.isElementAccessExpression(callee) &&
    isImportedNamespaceReceiver(callee.expression, imports) &&
    (ts.isStringLiteral(callee.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(callee.argumentExpression)) &&
    callee.argumentExpression.text === 'defineClosedVocabulary'
  );
}

function isImportedNamespaceReceiver(expression, imports) {
  const receiver = unwrapParentheses(expression);
  return (
    receiver !== undefined && ts.isIdentifier(receiver) && imports.namespaces.has(receiver.text)
  );
}

function rejectClosedVocabularySpelling(detail, call, diagnostics) {
  const declaration = enclosingVariableDeclaration(call);
  const owner = variableName(declaration) ?? 'defineClosedVocabulary';
  rejectShape(
    diagnostics,
    detail,
    call,
    'closed-vocabulary',
    owner,
    `${owner} must call defineClosedVocabulary with its direct identifier spelling`,
  );
}

function enclosingVariableDeclaration(node) {
  let current = node.parent;
  while (current !== undefined && !ts.isVariableDeclaration(current)) {
    current = current.parent;
  }
  return current;
}

function variableStatement(declaration) {
  const list = declaration?.parent;
  return list !== undefined &&
    ts.isVariableDeclarationList(list) &&
    ts.isVariableStatement(list.parent)
    ? list.parent
    : undefined;
}

function variableName(declaration) {
  return declaration !== undefined && ts.isIdentifier(declaration.name)
    ? declaration.name.text
    : undefined;
}

function isExportedConst(statement) {
  return (
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

function isContractPath(path, fileName) {
  const parts = path.toLowerCase().split('/');
  return parts.at(-2) === 'contracts' && parts.at(-1) === fileName;
}

function isEventContractPath(path) {
  return isContractPath(path, 'events.ts') || isContractPath(path, 'intents.ts');
}

function isCanonicalModuleContractPath(path, fileName) {
  const parts = path.toLowerCase().split('/');
  const modulePath = parts[0] === 'src' ? parts.slice(1) : parts;
  return modulePath.length === 3 && modulePath[1] === 'contracts' && modulePath[2] === fileName;
}

function visit(node, visitor) {
  visitor(node);
  node.forEachChild((child) => visit(child, visitor));
}
