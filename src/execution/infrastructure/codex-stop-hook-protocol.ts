export type CodexSessionId = string | number;

export interface StructuredResult {
  readonly exitCode?: number;
  readonly jsonExitCode?: number;
  readonly pendingCellId?: string;
  readonly notFoundCellId?: string;
  readonly sessionId?: CodexSessionId;
}

export function structuredResult(value: unknown): StructuredResult {
  return outputTexts(value).reduce(mergeResult, {});
}

function mergeResult(result: StructuredResult, text: string): StructuredResult {
  const jsonExitCode = jsonExitCodeInText(text);
  const session = sessionIdInText(text);
  const legacyExitCode = legacyExitCodeInText(text);
  const exitCode = jsonExitCode ?? legacyExitCode;
  return {
    ...result,
    ...(jsonExitCode === undefined ? {} : { jsonExitCode }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(session === undefined ? {} : { sessionId: session }),
    ...matchValue(text, /Script running with cell ID ([^\s]+)/, 'pendingCellId'),
    ...matchValue(text, /exec cell ([^\s]+) not found/, 'notFoundCellId'),
  };
}

function matchValue<Key extends 'pendingCellId' | 'notFoundCellId'>(
  text: string,
  pattern: RegExp,
  key: Key,
): Partial<Pick<StructuredResult, Key>> {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? {} : ({ [key]: value } as Pick<StructuredResult, Key>);
}

function jsonExitCodeInText(text: string): number | undefined {
  const result = parseJson(text);
  return result === undefined ? undefined : number(result.exit_code);
}

function legacyExitCodeInText(text: string): number | undefined {
  const rendered = /Exit code:\s*(-?\d+)/.exec(text)?.[1];
  return rendered === undefined ? undefined : Number(rendered);
}

function sessionIdInText(text: string): CodexSessionId | undefined {
  const result = parseJson(text);
  return result === undefined ? undefined : sessionId(result.session_id);
}

function outputTexts(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const content = record(item);
    const text = content === undefined ? undefined : string(content.text);
    return text === undefined ? [] : [text];
  });
}

export function writeStdinSessionArgument(input: unknown): {
  readonly writeStdinSessionId?: CodexSessionId;
} {
  if (typeof input !== 'string') return {};
  const code = codeMask(input);
  const calls = [...code.matchAll(/\btools\.write_stdin\s*\(\s*\{/g)];
  if (calls.length !== 1) return {};
  const call = calls[0];
  if (call === undefined || call.index === undefined) return {};
  const openObject = call.index + call[0].lastIndexOf('{');
  const literal = directSessionIdArgument(input, code, openObject);
  return literal === undefined ? {} : { writeStdinSessionId: literal };
}

function directSessionIdArgument(
  source: string,
  code: string,
  openObject: number,
): CodexSessionId | undefined {
  const literals = directSessionLiterals(source, code, openObject);
  return literals.length === 1 ? literals[0] : undefined;
}

function directSessionLiterals(source: string, code: string, openObject: number): CodexSessionId[] {
  const literals: CodexSessionId[] = [];
  let depth = 1;
  for (let index = openObject + 1; index < code.length && depth > 0; index += 1) {
    depth = nextDepth(code[index], depth);
    if (depth !== 1 || !isSessionIdAt(code, index)) continue;
    const literal = literalAtProperty(source, code, index);
    if (literal === undefined) return [];
    literals.push(literal);
  }
  return literals;
}

function nextDepth(character: string | undefined, depth: number): number {
  if (character === '{' || character === '[' || character === '(') return depth + 1;
  if (character === '}' || character === ']' || character === ')') return depth - 1;
  return depth;
}

function isSessionIdAt(code: string, index: number): boolean {
  const name = 'session_id';
  return (
    code.startsWith(name, index) &&
    !/[A-Za-z0-9_$]/.test(code[index - 1] ?? '') &&
    !/[A-Za-z0-9_$]/.test(code[index + name.length] ?? '')
  );
}

function literalAtProperty(
  source: string,
  code: string,
  index: number,
): CodexSessionId | undefined {
  let valueStart = index + 'session_id'.length;
  while (/\s/.test(code[valueStart] ?? '')) valueStart += 1;
  return code[valueStart] === ':' ? sourceSessionLiteralAt(source, valueStart + 1) : undefined;
}

function codeMask(source: string): string {
  const characters = source.split('');
  for (let index = 0; index < characters.length; index += 1) index = maskAt(characters, index);
  return characters.join('');
}

function maskAt(characters: string[], index: number): number {
  const character = characters[index];
  if (character === '/' && characters[index + 1] === '/') return maskLineComment(characters, index);
  if (character === '/' && characters[index + 1] === '*')
    return maskBlockComment(characters, index);
  return isQuote(character) ? maskQuoted(characters, index, character) : index;
}

function maskLineComment(characters: string[], index: number): number {
  while (index < characters.length && characters[index] !== '\n') characters[index++] = ' ';
  return index;
}

function maskBlockComment(characters: string[], index: number): number {
  characters[index++] = ' ';
  characters[index++] = ' ';
  while (index < characters.length && !(characters[index] === '*' && characters[index + 1] === '/'))
    characters[index++] = ' ';
  characters[index++] = ' ';
  characters[index] = ' ';
  return index;
}

function isQuote(value: string | undefined): value is '"' | "'" | '`' {
  return value === '"' || value === "'" || value === '`';
}

function maskQuoted(characters: string[], index: number, quote: string): number {
  characters[index++] = ' ';
  while (index < characters.length) {
    const current = characters[index];
    characters[index++] = ' ';
    if (current === '\\') {
      characters[index++] = ' ';
      continue;
    }
    if (current === quote) break;
  }
  return index;
}

function sourceSessionLiteralAt(source: string, start: number): CodexSessionId | undefined {
  while (/\s/.test(source[start] ?? '')) start += 1;
  const numeric = sourceNumberLiteralAt(source, start);
  if (numeric !== undefined) return sessionId(numeric);
  if (source[start] === "'") return sessionId(singleQuotedStringAt(source, start));
  if (source[start] !== '"') return undefined;
  const quoted = doubleQuotedStringAt(source, start);
  return quoted === undefined ? undefined : sessionId(quoted);
}

function doubleQuotedStringAt(source: string, start: number): string | undefined {
  let end = start + 1;
  while (end < source.length) {
    if (source[end] === '\\') {
      end += 2;
      continue;
    }
    if (source[end] === '"') {
      const value = parseJson(`{"value":${source.slice(start, end + 1)}}`);
      return value === undefined ? undefined : string(value.value);
    }
    end += 1;
  }
  return undefined;
}

function sourceNumberLiteralAt(source: string, start: number): number | undefined {
  const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  match.lastIndex = start;
  const literal = match.exec(source)?.[0];
  if (literal === undefined || /[A-Za-z0-9_$.]/.test(source[start + literal.length] ?? ''))
    return undefined;
  const value = Number(literal);
  return Number.isFinite(value) ? value : undefined;
}

function singleQuotedStringAt(source: string, start: number): string | undefined {
  let end = start + 1;
  while (end < source.length && source[end] !== "'") {
    if (source[end] === '\\') return undefined;
    end += 1;
  }
  return end < source.length ? source.slice(start + 1, end) : undefined;
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sessionId(value: unknown): CodexSessionId | undefined {
  const text = string(value);
  return text === undefined || text.length === 0 ? number(value) : text;
}
