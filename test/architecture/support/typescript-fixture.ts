import { readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import ts from 'typescript';

const compilerOptions: ts.CompilerOptions = {
  exactOptionalPropertyTypes: true,
  lib: ['lib.es2022.d.ts'],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  noImplicitOverride: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  types: ['node'],
};

export async function assertTypeScriptFixtureCompiles(root: string): Promise<void> {
  const sourceRoot = resolve(root, 'src');
  const program = ts.createProgram(await typescriptFiles(sourceRoot), compilerOptions);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) return;

  const messages = diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, sourceRoot));
  throw new Error(`Fixture has TypeScript diagnostics:\n${messages.join('\n')}`);
}

function formatDiagnostic(diagnostic: ts.Diagnostic, sourceRoot: string): string {
  const detail = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.file === undefined || diagnostic.start === undefined)
    return `TS${diagnostic.code}: ${detail}`;
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const fileName = isAbsolute(diagnostic.file.fileName)
    ? relative(sourceRoot, diagnostic.file.fileName)
    : diagnostic.file.fileName;
  return `${fileName.replaceAll('\\', '/')}:${line + 1}:${character + 1} TS${diagnostic.code}: ${detail}`;
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)));
    else if (
      entry.isFile() &&
      /\.(?:cts|mts|tsx?)$/.test(entry.name) &&
      !/\.d\.(?:cts|mts|ts)$/.test(entry.name)
    )
      files.push(path);
  }
  return files.sort();
}
