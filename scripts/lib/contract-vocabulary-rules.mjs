import { basename } from 'node:path';
import ts from 'typescript';

export function evaluateVocabulary(detail, catalogues, rules) {
  if (allowsRegisteredLiterals(detail.path)) return [];
  const diagnostics = [];

  visit(detail.source, (node) => {
    if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
    inspectLiteral(detail, node, catalogues, rules, diagnostics);
  });

  return diagnostics;
}

export function createShapeDiagnostic(detail, node, rule, owner, reason) {
  return createDiagnostic(detail, node, rule, '<catalogue-shape>', owner, reason);
}

export function sortDiagnostics(diagnostics) {
  return diagnostics.sort(
    (left, right) =>
      compareCodeUnits(left.path, right.path) ||
      left.position - right.position ||
      compareCodeUnits(left.rule, right.rule) ||
      compareCodeUnits(left.owner, right.owner),
  );
}

export function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function inspectLiteral(detail, literal, catalogues, rules, diagnostics) {
  const value = literal.text;
  inspectRegistrations(
    detail,
    literal,
    value,
    'closed-vocabulary',
    catalogues.closedValues,
    rules,
    diagnostics,
  );
  inspectRegistrations(
    detail,
    literal,
    value,
    'event-literals',
    catalogues.eventValues,
    rules,
    diagnostics,
  );
  inspectRegistrations(
    detail,
    literal,
    value,
    'stream-literals',
    catalogues.streamValues,
    rules,
    diagnostics,
  );
}

function inspectRegistrations(detail, literal, value, rule, registrations, rules, diagnostics) {
  if (!rules.has(rule)) return;
  if (isExplicitCatalogueLiteral(literal)) return;
  for (const registration of registrations.get(value) ?? []) {
    if (isInsideInitializer(detail, literal, registration)) continue;
    diagnostics.push(
      createDiagnostic(
        detail,
        literal,
        rule,
        value,
        registration.owner,
        `"${value}" must be replaced by ${registration.owner}`,
      ),
    );
  }
}

function isExplicitCatalogueLiteral(literal) {
  const declaration = ancestor(literal, ts.isVariableDeclaration);
  if (
    declaration === undefined ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined
  ) {
    return false;
  }
  const list = declaration.parent;
  const statement =
    ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent)
      ? list.parent
      : undefined;
  if (
    statement === undefined ||
    statement.parent !== literal.getSourceFile() ||
    (list.flags & ts.NodeFlags.Const) === 0 ||
    !(
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false
    )
  ) {
    return false;
  }
  if (declaration.name.text.endsWith('EventType') || declaration.name.text.endsWith('StreamKind')) {
    return true;
  }
  const initializer = unwrapParentheses(declaration.initializer);
  return (
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(unwrapParentheses(initializer.expression)) &&
    unwrapParentheses(initializer.expression).text === 'defineClosedVocabulary'
  );
}

function ancestor(node, predicate) {
  let current = node.parent;
  while (current !== undefined) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function unwrapParentheses(expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isInsideInitializer(detail, literal, registration) {
  const position = literal.getStart(detail.source);
  return (
    detail.path === registration.path &&
    position >= registration.initializerStart &&
    position < registration.initializerEnd
  );
}

function allowsRegisteredLiterals(path) {
  const normalized = path.toLowerCase();
  const parts = normalized.split('/');
  const fileName = basename(normalized);
  if (fileName.endsWith('.corrupt-fixture.ts')) return true;
  if (parts.includes('persistence')) return true;
  return (
    parts.includes('integrations') && /^.+-(?:decoder|translator|translation)\.ts$/.test(fileName)
  );
}

function createDiagnostic(detail, node, rule, value, owner, description) {
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
  return {
    ...diagnostic,
    message: `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} [${rule}] ${description}`,
  };
}

function visit(node, visitor) {
  visitor(node);
  node.forEachChild((child) => visit(child, visitor));
}
