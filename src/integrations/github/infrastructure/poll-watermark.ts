import type { CheckpointStore } from '@atolis-hq/eventing';
import type { AdapterId } from '../../contracts/identifiers.js';
import type { GitHubAdapterEventData } from '../contracts/events.js';

export const minimumPollOverlapMs = 5 * 60_000;

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
  return new Date(Math.max(0, watermark - Math.max(overlapMs, minimumPollOverlapMs))).toISOString();
}

export function providerWatermark(
  previous: number,
  updatedAts: readonly string[],
): number | undefined {
  const latest = updatedAts.reduce<number | undefined>((current, updatedAt) => {
    const timestamp = Date.parse(updatedAt);
    if (!Number.isFinite(timestamp) || timestamp < previous) return current;
    return current === undefined || timestamp > current ? timestamp : current;
  }, undefined);
  return latest === undefined || latest === previous ? undefined : latest;
}

export function hasProviderTimestamp(payload: { readonly updated_at: string }): boolean {
  return Number.isFinite(Date.parse(payload.updated_at));
}

export function timestampsValid(
  ...groups: readonly (readonly { readonly updated_at: string }[])[]
): boolean {
  return groups.flat().every(hasProviderTimestamp);
}

export function batchesSucceeded(batches: readonly PollBatch[]): boolean {
  return batches.every((batch) => batch.succeeded);
}

export function reportPartialPollFailure(repository: string, query: string): void {
  process.stderr.write(
    `GitHub poll partial failure for ${repository}: ${query}; preserving watermark for replay\n`,
  );
}
