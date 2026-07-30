import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cataloguePath = resolve(root, 'docs/architecture/functional-decision-catalogue.md');
const evidencePaths = [
  resolve(root, 'docs/architecture/legacy-test-evidence.txt'),
  resolve(root, 'docs/architecture/legacy-surface-evidence.txt'),
];
const headers = [
  'ID',
  'Intent or learned constraint',
  'Underlying mechanic',
  'Disposition',
  'Target owner',
  'Target scenarios',
  'Evidence',
];
const dispositions = new Set(['preserve', 'correct', 'consolidate', 'remove', 'defer']);
const scenarioRequired = new Set(['preserve', 'correct', 'consolidate']);
const mandatedIds = new Set([
  'WORK-INTAKE',
  'WORK-LIFECYCLE',
  'WORK-COMMAND',
  'RESOURCE-IDENTITY',
  'RESOURCE-CORRELATION',
  'RESOURCE-CONFLICT',
  'ORCH-CONFIG',
  'ORCH-TRANSITION',
  'ORCH-WAIT',
  'ORCH-CHILD',
  'ORCH-WATCH',
  'EXEC-RUN',
  'EXEC-RESULT',
  'EXEC-ROUTING',
  'EXEC-WORKSPACE',
  'EXEC-CANCEL',
  'EXEC-RECOVERY',
  'ACT-AGENT',
  'ACT-REVIEW',
  'ACT-PR-APPROVE',
  'ACT-PR-MERGE',
  'CONTROL-TICK',
  'CONTROL-RESIDENT',
  'CONTROL-SCHEDULE',
  'CONTROL-FAIRNESS',
  'CONTROL-QUOTA',
  'INT-GITHUB-ISSUE',
  'INT-GITHUB-PR',
  'INT-HUMAN-SIGNAL',
  'INT-PUBLISH',
  'INT-OUTBOX',
  'SURFACE-CLI',
  'SURFACE-API',
  'SURFACE-UI',
  'OPS-INIT',
  'OPS-DOCTOR',
  'OPS-SANDBOX',
  'OPS-SELF-UPDATE',
  'OPS-TRANSCRIPT',
]);
const scenarioListPattern = /^E2E-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:,\s*E2E-[A-Z0-9]+(?:-[A-Z0-9]+)*)*$/;
const failures = [];

const catalogue = readFileSync(cataloguePath, 'utf8');
const lines = catalogue.split(/\r?\n/);
const expectedHeader = `| ${headers.join(' | ')} |`;
const headerIndex = lines.findIndex((line) => line.trim() === expectedHeader);

if (headerIndex === -1) {
  failures.push(`missing exact table header: ${expectedHeader}`);
}

const parseCells = (line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return [];
  }
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
};

const rows = [];
if (headerIndex !== -1) {
  const separatorCells = parseCells(lines[headerIndex + 1] ?? '');
  if (
    separatorCells.length !== headers.length ||
    separatorCells.some((cell) => !/^:?-{3,}:?$/.test(cell))
  ) {
    failures.push('table separator must contain exactly seven Markdown separator cells');
  }

  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith('|')) {
      break;
    }
    const cells = parseCells(line);
    if (cells.length !== headers.length) {
      failures.push(`table row ${index + 1} has ${cells.length} cells; expected 7`);
      continue;
    }
    rows.push({ cells, lineNumber: index + 1 });
  }
}

if (rows.length === 0) {
  failures.push('catalogue contains no decision rows');
}

const ids = new Set();
for (const { cells, lineNumber } of rows) {
  for (let index = 0; index < headers.length; index += 1) {
    if (cells[index].length === 0) {
      failures.push(`row ${lineNumber} has an empty ${headers[index]} cell`);
    }
  }

  const [id, intent, , disposition, , scenarios] = cells;
  if (id.length > 0) {
    if (ids.has(id)) {
      failures.push(`duplicate decision ID ${id} on row ${lineNumber}`);
    }
    ids.add(id);
  }

  if (!dispositions.has(disposition)) {
    failures.push(`row ${lineNumber} has invalid disposition ${disposition || '<empty>'}`);
  }

  if (disposition === 'remove' && !intent.includes('Remove because')) {
    failures.push(`row ${lineNumber} must state an explicit "Remove because" reason`);
  }
  if (disposition === 'defer' && !intent.includes('Defer because')) {
    failures.push(`row ${lineNumber} must state an explicit "Defer because" reason`);
  }

  if (scenarioRequired.has(disposition)) {
    if (!scenarioListPattern.test(scenarios)) {
      failures.push(`row ${lineNumber} must list one or more comma-separated E2E-* scenario IDs`);
    }
  }
}

for (const mandatedId of mandatedIds) {
  if (!ids.has(mandatedId)) {
    failures.push(`catalogue is missing mandated decision family ${mandatedId}`);
  }
}

const evidenceCells = rows.map(({ cells }) => cells[6]).join('\n');
for (const evidencePath of evidencePaths) {
  const paths = readFileSync(evidencePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const path of paths) {
    if (!evidenceCells.includes(`\`${path}\``)) {
      failures.push(`frozen evidence path is not cited in an Evidence cell: ${path}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Catalogue invalid:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Catalogue valid: ${rows.length} decisions`);
}
