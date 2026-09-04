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
  if (isRegisteredCatalogueLiteral(detail, literal, catalogues)) return;
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
  for (const registration of registrations.get(value) ?? []) {
    if (
      registration.moduleScope !== undefined &&
      moduleScope(detail.path) !== registration.moduleScope
    )
      continue;
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

function moduleScope(path) {
  const parts = path.split('/');
  return parts[0] === 'src' ? parts[1] : parts[0];
}

function isRegisteredCatalogueLiteral(detail, literal, catalogues) {
  for (const registrations of [
    catalogues.closedValues,
    catalogues.eventValues,
    catalogues.streamValues,
  ]) {
    for (const entries of registrations.values()) {
      if (entries.some((registration) => isInsideInitializer(detail, literal, registration))) {
        return true;
      }
    }
  }
  return false;
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
  if (parts.includes('eventing-filesystem')) return true;
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
