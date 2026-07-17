import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { createDefaultWakeConfig } from '../src/config/defaults.js';
import type { IssueStateRecord, RunRecord, WakeConfig } from '../src/domain/types.js';
import { writeJsonFile } from '../src/lib/json-file.js';
import { createWakePaths } from '../src/lib/paths.js';

const execFile = promisify(nodeExecFile);

export function buildE2eConfig(input: {
  wakeRoot: string;
  repo: string;
  requiredLabel: string;
}): WakeConfig {
  const config = createDefaultWakeConfig(input.wakeRoot);
  return {
    ...config,
    sources: {
      github: {
        ...config.sources.github,
        enabled: true,
        repos: [input.repo],
        policy: {
          ...config.sources.github.policy,
          requiredLabels: [input.requiredLabel],
          ignoredLabels: [],
        },
      },
    },
  };
}

export function parseIssueNumberFromUrl(issueUrl: string): number {
  const issueNumber = Number(issueUrl.trim().split('/').at(-1));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Could not parse issue number from URL: ${issueUrl}`);
  }
  return issueNumber;
}

export function validateTickOutcome(
  outcome: unknown,
  input: {
    expectedStatus: 'idle' | 'processed';
    expectedSentinel?: 'DONE' | 'BLOCKED' | 'FAILED';
  },
): void {
  if (outcome === null || typeof outcome !== 'object') {
    throw new Error('Tick output was not a JSON object');
  }

  const status = (outcome as { status?: unknown }).status;
  if (status !== input.expectedStatus) {
    throw new Error(
      `Expected tick status ${input.expectedStatus} but received ${String(status)}`,
    );
  }

  if (input.expectedSentinel !== undefined) {
    const sentinel = (outcome as { sentinel?: unknown }).sentinel;
    if (sentinel !== input.expectedSentinel) {
      throw new Error(
        `Expected tick sentinel ${input.expectedSentinel} but received ${String(sentinel)}`,
      );
    }
  }
}

export async function waitForProcessedTick(input: {
  maxAttempts: number;
  delayMs: number;
  runTick: () => Promise<unknown>;
}) {
  let lastOutcome: unknown;

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    lastOutcome = await input.runTick();
    if (
      lastOutcome !== null &&
      typeof lastOutcome === 'object' &&
      (lastOutcome as { status?: unknown }).status === 'processed'
    ) {
      return lastOutcome;
    }

    if (attempt < input.maxAttempts) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, input.delayMs));
    }
  }

  return lastOutcome;
}

async function runCommand(command: string, args: string[], cwd: string) {
  const result = await execFile(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  });

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function runTick(repoRoot: string, wakeRoot: string) {
  const result = await runCommand(
    process.execPath,
    [
      resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/main.ts',
      'tick',
      '--wake-root',
      wakeRoot,
    ],
    repoRoot,
  );

  return JSON.parse(result.stdout) as unknown;
}

async function ensureLabel(repo: string, label: string, cwd: string) {
  try {
    await runCommand('gh', ['label', 'create', label, '--repo', repo, '--color', 'BFD4F2', '--description', 'Wake E2E test label'], cwd);
  } catch {
    // Label already exists or user lacks permission; the later issue create step will fail clearly if unusable.
  }
}

async function createIssue(repo: string, label: string, cwd: string) {
  const title = `Wake E2E fake runner ${new Date().toISOString()}`;
  const result = await runCommand(
    'gh',
    [
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      title,
      '--body',
      'E2E check for Wake GitHub Issues fake runner.',
      '--label',
      label,
    ],
    cwd,
  );

  return {
    url: result.stdout,
    issueNumber: parseIssueNumberFromUrl(result.stdout),
  };
}

async function closeIssue(repo: string, issueNumber: number, cwd: string) {
  await runCommand(
    'gh',
    ['issue', 'close', String(issueNumber), '--repo', repo, '--comment', 'Wake E2E cleanup'],
    cwd,
  );
}

async function readIssueState(wakeRoot: string, repo: string, issueNumber: number) {
  // state/ is keyed by the opaque minted work id, so the projection is found
  // by the ticket it represents, via its retained issue snapshot.
  const stateRoot = join(wakeRoot, 'state');
  const files = (await readdir(stateRoot).catch(() => []))
    .filter((file) => file.endsWith('.json'));

  for (const file of files) {
    const raw = await readFile(join(stateRoot, file), 'utf8');
    const record = JSON.parse(raw) as IssueStateRecord;
    if (record.issue?.repo === repo && record.issue?.number === issueNumber) {
      return record;
    }
  }

  throw new Error(`No projection found for ${repo}#${issueNumber}`);
}

async function readLatestRun(wakeRoot: string): Promise<RunRecord> {
  const paths = createWakePaths(wakeRoot);
  const files = await (await import('node:fs/promises')).readdir(join(wakeRoot, 'runs'));
  const latest = files.sort().at(-1);
  if (latest === undefined) {
    throw new Error('No run record was written');
  }

  const raw = await readFile(join(wakeRoot, 'runs', latest), 'utf8');
  return JSON.parse(raw) as RunRecord;
}

async function assertEventLogContains(wakeRoot: string, expected: string[]) {
  const eventDate = new Date().toISOString().slice(0, 10);
  const raw = await readFile(join(wakeRoot, 'events', `${eventDate}.jsonl`), 'utf8');

  for (const token of expected) {
    if (!raw.includes(token)) {
      throw new Error(`Expected event log to contain ${token}`);
    }
  }
}

async function main() {
  const repoRoot = process.cwd();
  const repo = 'atolis-hq/wake';
  const requiredLabel = 'wake:e2e';
  const wakeRoot = resolve(tmpdir(), `wake-e2e-${Date.now()}`);
  const cleanup = !process.argv.includes('--keep');

  await mkdir(wakeRoot, { recursive: true });
  await writeJsonFile(
    join(wakeRoot, 'config.json'),
    buildE2eConfig({
      wakeRoot,
      repo,
      requiredLabel,
    }),
  );

  await ensureLabel(repo, requiredLabel, repoRoot);

  const firstTick = await runTick(repoRoot, wakeRoot);
  validateTickOutcome(firstTick, { expectedStatus: 'idle' });

  const issue = await createIssue(repo, requiredLabel, repoRoot);

  try {
    const secondTick = await waitForProcessedTick({
      maxAttempts: 6,
      delayMs: 2000,
      runTick: () => runTick(repoRoot, wakeRoot),
    });
    validateTickOutcome(secondTick, {
      expectedStatus: 'processed',
      expectedSentinel: 'DONE',
    });

    const issueState = await readIssueState(wakeRoot, repo, issue.issueNumber);
    if (issueState.wake.stage !== 'implement') {
      throw new Error(`Expected synced issue stage to be implement but received ${issueState.wake.stage}`);
    }

    const latestRun = await readLatestRun(wakeRoot);
    if (latestRun.status !== 'completed' || latestRun.summary?.includes('Fake runner completed') !== true) {
      throw new Error('Expected a completed fake runner run record');
    }

    await assertEventLogContains(wakeRoot, [
      '"sourceEventType":"ticket.upsert"',
      '"sourceEventType":"wake.run.completed"',
      '"sourceEventType":"wake.publish.intent.requested"',
      '"sourceEventType":"ticket.reply.published"',
    ]);

    console.log(
      JSON.stringify(
        {
          ok: true,
          wakeRoot,
          issueUrl: issue.url,
          issueNumber: issue.issueNumber,
        },
        null,
        2,
      ),
    );
  } finally {
    if (cleanup) {
      await closeIssue(repo, issue.issueNumber, repoRoot);
      await rm(wakeRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
