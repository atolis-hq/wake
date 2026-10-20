import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

// A resident tick must cost what changed, never the length of history. The
// only unbounded journal reads allowed in production code are listed here with
// the reason each is not a resident-loop read. Anything else belongs in a
// ProjectionStore projection (readCurrentProjection) or a foldedJournalView.
const unboundedReadAllowlist: Readonly<Record<string, string>> = {
  'packages/eventing/src/runtime/journal-view.ts':
    'foldedJournalView reads only the tail after the position it already holds',
  'src/bootstrap/surface-api-applications.ts':
    'fallback for journals without readLatest; the production journal pages from the end',
  'src/bootstrap/surface-cli-applications.ts':
    'the one-off `wake audit` command, run per invocation and not in a resident loop',
  'src/surfaces/cli/commands/audit.ts':
    'one-off audit over canonical facts, deliberately independent of projections',
};

// Journal implementations define and delegate readAll; they are not consumers.
const journalImplementations = [
  'packages/eventing-filesystem/src/',
  'packages/eventing/src/memory/',
  'src/bootstrap/persistence-composition.ts',
];

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.endsWith('.test.ts'))
      files.push(path);
  }
  return files;
}

async function productionFiles(): Promise<string[]> {
  const packages = (await readdir(join(root, 'packages'))).map((name) => `packages/${name}/src`);
  const found = await Promise.all(['src', ...packages].map((directory) => sourceFiles(directory)));
  return found.flat().filter((file) => !journalImplementations.some((p) => file.startsWith(p)));
}

function isZeroLiteral(node: ts.Expression | undefined): boolean {
  return node !== undefined && ts.isNumericLiteral(node) && node.text === '0';
}

/** A `readAll` call is unbounded unless it carries a limit; `readAll(0, n)` with a computed n is a full scan in disguise. */
function unboundedReadAllCalls(file: ts.SourceFile): string[] {
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'readAll'
    ) {
      const [after, limit] = node.arguments;
      const bounded = limit !== undefined && !(isZeroLiteral(after) && !ts.isNumericLiteral(limit));
      if (!bounded) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart());
        calls.push(`${file.fileName}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

describe('journal read patterns', () => {
  it('allows an unbounded journal read only at the listed non-resident call sites', async () => {
    const unexpected: string[] = [];
    const seenAllowed = new Set<string>();
    for (const path of await productionFiles()) {
      const source = ts.createSourceFile(
        path,
        await readFile(join(root, path), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const calls = unboundedReadAllCalls(source);
      if (calls.length === 0) continue;
      if (path in unboundedReadAllowlist) seenAllowed.add(path);
      else unexpected.push(...calls);
    }

    expect(
      unexpected,
      'Unbounded journal.readAll in production code re-reads history on every call. Use a ' +
        'ProjectionStore projection with readCurrentProjection(), or a foldedJournalView() that ' +
        'folds only new events. If it truly is not a resident-loop read, add it to the allowlist ' +
        'with the reason.',
    ).toEqual([]);
    expect([...seenAllowed].sort(), 'stale allowlist entry: no unbounded read remains').toEqual(
      Object.keys(unboundedReadAllowlist).sort(),
    );
  });

  it('does not reintroduce a re-derive-everything-on-every-journal-move view', async () => {
    const offenders: string[] = [];
    for (const path of await productionFiles())
      if ((await readFile(join(root, path), 'utf8')).includes('cachedJournalView'))
        offenders.push(relative(root, join(root, path)));

    expect(
      offenders,
      'cachedJournalView re-read and re-decoded the whole journal whenever it moved. Fold only ' +
        'new events with foldedJournalView(), or read a projection.',
    ).toEqual([]);
  });

  it('flags a computed-limit full scan in disguise', () => {
    const flagged = (code: string) =>
      unboundedReadAllCalls(ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true));

    expect(flagged('journal.readAll(0)')).toHaveLength(1);
    expect(flagged('journal.readAll(stored?.lastGlobalPosition ?? 0)')).toHaveLength(1);
    expect(flagged('journal.readAll(0, limit)')).toHaveLength(1);
    expect(flagged('journal.readAll(position, 256)')).toHaveLength(0);
    expect(flagged('journal.readAll(0, 1)')).toHaveLength(0);
    expect(flagged('journal.readAll(checkpoint, batchSize)')).toHaveLength(0);
  });
});
