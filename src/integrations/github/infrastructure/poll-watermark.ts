import type { CheckpointStore } from '../../../kernel/index.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import type { GitHubAdapterEventData } from '../contracts/events.js';

export interface PollBatch {
  readonly drafts: readonly GitHubAdapterEventData[];
  readonly succeeded: boolean;
}

export function mergeBatches(batches: readonly PollBatch[]): PollBatch {
  return {
    drafts: batches.flatMap((batch) => batch.drafts),
    succeeded: batches.every((batch) => batch.succeeded),
  };
}

export function watermarkCheckpoint(adapter: AdapterId | undefined, repository: string): string {
  return `source:github:${adapter ?? 'github'}:${encodeURIComponent(repository)}`;
}

export async function loadWatermark(
  checkpoints: CheckpointStore | undefined,
  adapter: AdapterId | undefined,
  owner: string,
  repo: string,
): Promise<number> {
  if (checkpoints === undefined) return 0;
  return checkpoints.load(watermarkCheckpoint(adapter, `${owner}/${repo}`));
}

export function overlapSince(watermark: number, overlapMs: number): string | undefined {
  if (!Number.isFinite(watermark) || watermark <= 0) return undefined;
  return new Date(Math.max(0, watermark - overlapMs)).toISOString();
}

export function reportPartialPollFailure(repository: string, query: string): void {
  process.stderr.write(
    `GitHub poll partial failure for ${repository}: ${query}; preserving watermark for replay\n`,
  );
}
