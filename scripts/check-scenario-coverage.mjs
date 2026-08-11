import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cataloguePath =
  process.env.SCENARIO_CATALOGUE ??
  resolve(root, 'docs/architecture/functional-decision-catalogue.md');
const scenariosRoot = process.env.SCENARIO_TEST_ROOT ?? resolve(root, 'test/e2e');
const scenarioId = /E2E-[A-Z0-9-]+/g;
const definedScenario = /\bid\s*:\s*['"](E2E-[A-Z0-9-]+)['"]/g;
const allowedUncatalogued = /^(E2E-HARNESS-|E2E-GOLDEN-)/;
const failures = [];

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function catalogueScenarioIds(catalogue) {
  const rows = catalogue.split(/\r?\n/u);
  const header = rows.find((row) => row.startsWith('|') && row.includes('Target scenarios'));
  if (header === undefined) return new Set();
  const column = tableCells(header).findIndex((cell) => cell.trim() === 'Target scenarios');
  if (column < 0) return new Set();
  return new Set(
    rows
      .filter((row) => row.startsWith('|') && !/^\|\s*-/.test(row))
      .flatMap((row) => tableCells(row).at(column)?.match(scenarioId) ?? []),
  );
}

function tableCells(row) {
  return row.split('|').slice(1, -1);
}

const catalogue = readFileSync(cataloguePath, 'utf8');
const catalogueScenarios = catalogueScenarioIds(catalogue);
const definitions = new Map();
for (const path of testFiles(scenariosRoot)) {
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(definedScenario)) {
    const id = match[1];
    const descriptor = match.index;
    const prefix = source.slice(Math.max(0, (descriptor ?? 0) - 200), descriptor ?? 0);
    const name = /(?:const|let)\s+(\w+)\s*=\s*\{[^}]*$/.exec(prefix)?.[1];
    const registeredByReference =
      name !== undefined &&
      new RegExp(`\\b(?:it|describe)(?:\\.each\\([\\s\\S]{0,300}\\))?\\s*\\(`).test(source) &&
      (source.includes(`\${${name}.id}`) || source.includes(`describe(${name}.id`));
    const registeredByHelper = new RegExp(
      `\\bdefineScenario\\s*\\(\\s*\\{[\\s\\S]{0,300}\\bid\\s*:\\s*['"]${id}['"]`,
    ).test(source);
    const registered = registeredByReference || registeredByHelper;
    if (!registered) {
      failures.push(
        `catalogue scenario has no registered target test tied to its descriptor: ${id} (${path.slice(root.length + 1)})`,
      );
    }
    const paths = definitions.get(id) ?? [];
    paths.push(path.slice(root.length + 1));
    definitions.set(id, paths);
  }
}

for (const id of catalogueScenarios) {
  if (!definitions.has(id)) failures.push(`catalogue scenario has no target definition: ${id}`);
}
for (const [id, paths] of definitions) {
  if (paths.length > 1)
    failures.push(`duplicate target scenario definition ${id}: ${paths.join(', ')}`);
  if (!catalogueScenarios.has(id) && !allowedUncatalogued.test(id)) {
    failures.push(`target scenario is not referenced by the catalogue: ${id}`);
  }
}

if (failures.length > 0) {
  console.error('Scenario coverage invalid:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Scenario coverage valid: ${catalogueScenarios.size} catalogue scenario IDs`);
}
