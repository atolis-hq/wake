import { access } from 'node:fs/promises';

import { isWakeAuthoredComment, parseIssueStateRecord } from '../../domain/schema.js';
import type { IssueStateRecord } from '../../domain/types.js';
import { readJsonFile } from '../../lib/json-file.js';

export interface FakeIssueSeed {
  repo: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: Array<{
    id: string;
    body: string;
    author: {
      login: string;
    };
  }>;
}

function stageFromLabels(labels: string[]): IssueStateRecord['wake']['stage'] {
  if (labels.includes('wake:blocked')) {
    return 'blocked';
  }

  if (labels.includes('wake:refined')) {
    return 'refined';
  }

  if (labels.includes('wake:active')) {
    return 'active';
  }

  if (labels.includes('wake:done')) {
    return 'done';
  }

  if (labels.includes('wake:failed')) {
    return 'failed';
  }

  return 'queue';
}

function normalizeIssue(issue: FakeIssueSeed, nowIso: string): IssueStateRecord {
  return parseIssueStateRecord({
    schemaVersion: 1,
    issue: {
      repo: issue.repo,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      assignees: [],
      state: 'open',
      url: `https://example.test/${issue.repo}/issues/${issue.number}`,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    comments: issue.comments.map((comment) => ({
      ...comment,
      createdAt: nowIso,
      updatedAt: nowIso,
      isWakeAuthored: isWakeAuthoredComment(comment.body),
    })),
    wake: {
      stage: stageFromLabels(issue.labels),
      attempts: 0,
      stageHistory: [],
      syncedAt: nowIso,
    },
    context: {},
  });
}

export function createFakeWorkSource(options: {
  issues: FakeIssueSeed[];
  now?: () => Date;
}) {
  return {
    async syncIssues(): Promise<IssueStateRecord[]> {
      const nowIso = (options.now ?? (() => new Date()))().toISOString();
      return options.issues.map((issue) => normalizeIssue(issue, nowIso));
    },
  };
}

export async function createFileBackedFakeWorkSource(options: {
  fixturePath: string;
  now?: () => Date;
}) {
  try {
    await access(options.fixturePath);
  } catch {
    return createFakeWorkSource(
      options.now === undefined
        ? { issues: [] }
        : { issues: [], now: options.now },
    );
  }

  const raw = await readJsonFile<FakeIssueSeed[]>(options.fixturePath);
  return createFakeWorkSource(
    options.now === undefined
      ? { issues: raw }
      : { issues: raw, now: options.now },
  );
}
