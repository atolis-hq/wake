import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const RULE_NAME = 'provider-locality';

// A provider is any directory under src-next/integrations that is not part of
// the shared provider-agnostic scaffolding (contracts/application/delivery/fake).
const NON_PROVIDER_DIRECTORIES = new Set(['contracts', 'application', 'delivery', 'fake']);

// Identity/stream constructors a provider name must never reach as a value.
const IDENTITY_MINT_FUNCTIONS = new Set([
  'workItemId',
  'resourceId',
  'workItemStream',
  'workStream',
  'resourceStream',
]);

// The adapter id is the one sanctioned place a provider name is meant to
// travel outside its own namespace, so it is exempt everywhere.
const PERMITTED_LITERAL_PROPERTY = 'adapter';
const PERMITTED_LITERAL_FUNCTION = 'adapterId';

export async function deriveProviders(integrationsRoot) {
  let entries;
  try {
    entries = await readdir(resolve(integrationsRoot), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !NON_PROVIDER_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function evaluateProviderLocality(detail, providers) {
  if (providers.length === 0) return [];
  const diagnostics = [];

  if (!isCompositionRootPath(detail.path)) {
    const outOfNamespaceProviders = providers.filter(
      (provider) => !isWithinProviderNamespace(detail.path, provider),
    );
    if (outOfNamespaceProviders.length > 0) {
      diagnostics.push(...pathScopeDiagnostics(detail, outOfNamespaceProviders));
    }
  }

  if (providers.some((provider) => isWithinProviderNamespace(detail.path, provider))) {
    diagnostics.push(...valueScopeDiagnostics(detail, providers));
  }

  return diagnostics;
}

function isWithinProviderNamespace(path, provider) {
  const segments = path.split('/');
  const index = segments.indexOf('integrations');
  return index !== -1 && segments[index + 1] === provider;
}

// Bootstrap is the only production composition location and must be free to
// name the concrete providers it registers.
function isCompositionRootPath(path) {
  const segments = path.split('/');
  return segments.at(-2) === 'bootstrap' && segments.at(-1) === 'composition-root.ts';
}

function pathScopeDiagnostics(detail, providers) {
  const diagnostics = [];
  visit(detail.source, (node) => {
    if (ts.isIdentifier(node)) {
      matchProviders(detail, node, node.text, providers, diagnostics, pathScopeMessage);
      return;
    }
    if (isLiteralTextNode(node) && !isPermittedProviderLiteral(node)) {
      matchProviders(detail, node, node.text, providers, diagnostics, pathScopeMessage);
    }
  });
  return diagnostics;
}

function valueScopeDiagnostics(detail, providers) {
  const diagnostics = [];
  visit(detail.source, (node) => {
    if (ts.isCallExpression(node) && isIdentityMintCall(node)) {
      const calleeName = node.expression.text;
      for (const argument of node.arguments) {
        for (const literal of literalPiecesOf(argument)) {
          if (isPermittedProviderLiteral(literal)) continue;
          matchProviders(detail, literal, literal.text, providers, diagnostics, (provider) =>
            identityMessage(provider, calleeName),
          );
        }
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'eventType'
    ) {
      const text = staticEventTypeText(node.initializer);
      if (text !== undefined && (text.startsWith('work.') || text.startsWith('resource.'))) {
        for (const literal of literalPiecesOf(node.initializer)) {
          if (isPermittedProviderLiteral(literal)) continue;
          matchProviders(detail, literal, literal.text, providers, diagnostics, eventTypeMessage);
        }
      }
    }
    if (ts.isObjectLiteralExpression(node) && isStreamValuePosition(node)) {
      const kindProperty = findProperty(node, 'kind');
      if (kindProperty !== undefined && isWorkOrResourceStreamKindValue(kindProperty.initializer)) {
        for (const literal of streamLiteralPieces(node)) {
          if (isPermittedProviderLiteral(literal)) continue;
          matchProviders(detail, literal, literal.text, providers, diagnostics, streamMessage);
        }
      }
    }
  });
  return diagnostics;
}

function isIdentityMintCall(call) {
  return ts.isIdentifier(call.expression) && IDENTITY_MINT_FUNCTIONS.has(call.expression.text);
}

function isStreamValuePosition(node) {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text === 'stream' && parent.initializer === node;
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text === 'stream' && parent.initializer === node;
  }
  return false;
}

function findProperty(object, name) {
  return object.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
}

function isWorkOrResourceStreamKindValue(node) {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return /^(Work|Resource)\w*StreamKind$/.test(node.expression.text);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return /^(work|resource)/i.test(node.text);
  }
  return false;
}

function staticEventTypeText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return undefined;
}

function literalPiecesOf(node) {
  const pieces = [];
  collectLiteralNodes(node, pieces);
  return pieces;
}

function collectLiteralNodes(node, out) {
  if (isLiteralTextNode(node)) {
    out.push(node);
    return;
  }
  node.forEachChild((child) => collectLiteralNodes(child, out));
}

// A "stream" object's own id/kind literals are collected here, except the
// piece of any nested identity-mint call, which reports itself with a more
// specific message during the same traversal.
function streamLiteralPieces(node) {
  const pieces = [];
  collectStreamLiteralNodes(node, pieces);
  return pieces;
}

function collectStreamLiteralNodes(node, out) {
  if (isLiteralTextNode(node)) {
    out.push(node);
    return;
  }
  if (ts.isCallExpression(node) && isIdentityMintCall(node)) return;
  node.forEachChild((child) => collectStreamLiteralNodes(child, out));
}

function isLiteralTextNode(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

function isPermittedProviderLiteral(node) {
  let current = node;
  while (current.parent !== undefined && ts.isTemplateExpression(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  if (parent === undefined) return false;
  if (
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === PERMITTED_LITERAL_FUNCTION &&
    parent.arguments.includes(current)
  ) {
    return true;
  }
  return (
    ts.isPropertyAssignment(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === PERMITTED_LITERAL_PROPERTY &&
    parent.initializer === current
  );
}

function matchProviders(detail, node, text, providers, diagnostics, messageFor) {
  const lower = text.toLowerCase();
  for (const provider of providers) {
    if (!lower.includes(provider.toLowerCase())) continue;
    diagnostics.push(createDiagnostic(detail, node, provider, messageFor(provider)));
  }
}

function pathScopeMessage(provider) {
  return `Provider "${provider}" must not appear outside src-next/integrations/${provider}/**`;
}

function identityMessage(provider, calleeName) {
  return `Provider "${provider}" must not appear in a ${calleeName}(...) argument; identity is minted, not derived from provider data`;
}

function eventTypeMessage(provider) {
  return `Provider "${provider}" must not appear in a work.*/resource.* eventType value`;
}

function streamMessage(provider) {
  return `Provider "${provider}" must not appear in a Work/Resource stream value`;
}

function createDiagnostic(detail, node, provider, description) {
  const position = node.getStart(detail.source);
  const { line, character } = detail.source.getLineAndCharacterOfPosition(position);
  return {
    rule: RULE_NAME,
    path: detail.path,
    line: line + 1,
    column: character + 1,
    position,
    value: provider,
    owner: provider,
    message: `${detail.path}:${line + 1}:${character + 1} [${RULE_NAME}] ${description}`,
  };
}

function visit(node, visitor) {
  visitor(node);
  node.forEachChild((child) => visit(child, visitor));
}
