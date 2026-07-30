import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeTranscript(
  directory: string,
  runId: string,
  kind: 'prompt' | 'response',
  text: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${safe(runId)}.${kind}.txt`);
  await writeFile(path, text, 'utf8');
  return path;
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}
