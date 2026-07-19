import type { ResourceIndex, UnkeyedEventEnvelope } from '../../core/contracts.js';
import type { EventEnvelope, WakeConfig } from '../../domain/types.js';
import { buildResourceUri } from '../../domain/resource-uri.js';
import { createUnkeyedEventEnvelope, createEventEnvelope } from '../../lib/event-log.js';
import { formatWakeComment, readControlPlaneUiUrl } from './github-issues-work-source.js';

const githubPrSource = 'github-pr';
const wakeCommentMarker = '<!-- wake:agent -->';

type GitHubPullRequest = {
  number: number;
  html_url: string;
  user: { login?: string } | null;
  head: { ref: string };
  updated_at: string;
};

type GitHubComment = {
  id: number;
  body?: string;
  user?: { login?: string; type?: string } | null;
  created_at: string;
  updated_at: string;
  html_url?: string;
};

type GitHubReview = {
  id: number;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
  submitted_at?: string;
  html_url?: string;
  state: string;
};

type GitHubReviewComment = {
  id: number;
  in_reply_to_id?: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  user?: { login?: string; type?: string } | null;
  created_at: string;
  updated_at: string;
  html_url?: string;
};

function prResourceUri(repo: string, number: number): string {
  return buildResourceUri('github', 'pr', `${repo}#${number}`);
}

function reviewThreadRootId(comment: GitHubReviewComment, byId: Map<number, GitHubReviewComment>): number {
  let current = comment;
  const visited = new Set<number>();
  while (current.in_reply_to_id !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = byId.get(current.in_reply_to_id);
    if (parent === undefined) {
      break;
    }
    current = parent;
  }
  return current.id;
}

function reviewThreadResourceUri(repo: string, prNumber: number, rootId: number): string {
  return buildResourceUri('github', 'pr-review-thread', `${repo}#${prNumber}/rt_${rootId}`);
}

// selfLogin is the only reliable signal for an agent-authored comment posted
// by direct API/CLI call (e.g. a `revise` run replying via `gh api
// .../replies`), which never carries the marker and whose account `type` is
// `User`, not `Bot` — checking only those two would let the agent's own
// replies look human and re-trigger another run against themselves (#258
// follow-up incident: 99 duplicate replies from exactly this gap). Optional
// because it's undefined when the GitHub client is a fake/test double.
function isBotAuthored(
  comment: { user?: { login?: string; type?: string } | null; body?: string | null },
  selfLogin: string | undefined,
): boolean {
  return (
    comment.user?.type === 'Bot' ||
    (comment.body ?? '').includes(wakeCommentMarker) ||
    (selfLogin !== undefined && comment.user?.login === selfLogin)
  );
}

export function createGitHubPullRequestActivitySource(deps: {
  client: {
    listPullRequests: (owner: string, repo: string, maxResults: number) => Promise<GitHubPullRequest[]>;
    getPullRequest: (owner: string, repo: string, pullNumber: number) => Promise<GitHubPullRequest>;
    listComments: (owner: string, repo: string, prNumber: number, perPage: number) => Promise<GitHubComment[]>;
    listReviews: (owner: string, repo: string, prNumber: number, perPage: number) => Promise<GitHubReview[]>;
    listReviewComments: (owner: string, repo: string, prNumber: number, perPage: number) => Promise<GitHubReviewComment[]>;
    replyToReviewComment: (owner: string, repo: string, prNumber: number, commentId: number, body: string) => Promise<unknown>;
    createComment: (owner: string, repo: string, prNumber: number, body: string) => Promise<unknown>;
  };
  stateStore: ReturnType<typeof import('../fs/state-store.js').createStateStore>;
  config: WakeConfig;
  resourceIndex: ResourceIndex;
  now: () => Date;
  selfLogin?: string;
}) {
  function repoAndNumberFromPrUri(resourceUri: string): { owner: string; repo: string; repoRef: string; number: number } | null {
    // github:pr:<owner>/<repo>#<number>
    const locator = resourceUri.split(':').slice(2).join(':');
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(locator);
    if (match === null) {
      return null;
    }
    const [, owner, repo, numberStr] = match;
    if (owner === undefined || repo === undefined || numberStr === undefined) {
      return null;
    }
    return { owner, repo, repoRef: `${owner}/${repo}`, number: Number(numberStr) };
  }

  async function discoverPullRequests(ingestedAt: string): Promise<UnkeyedEventEnvelope[]> {
    if (!deps.config.sources.github.pullRequests.enabled) {
      return [];
    }

    const events: UnkeyedEventEnvelope[] = [];
    for (const repoRef of deps.config.sources.github.repos) {
      const [owner, repo] = repoRef.split('/');
      if (owner === undefined || repo === undefined) {
        continue;
      }

      try {
        const prs = await deps.client.listPullRequests(
          owner,
          repo,
          deps.config.sources.github.pullRequests.maxPullRequestsPerRepo,
        );

        for (const pr of prs) {
          const resourceUri = prResourceUri(repoRef, pr.number);
          const known = await deps.resourceIndex.resolve(resourceUri);
          if (known !== undefined) {
            continue;
          }

          events.push(
            createUnkeyedEventEnvelope({
              // Embeds updated_at (mirroring the issue path's ticket.upsert
              // eventId) so a PR that fails mint qualification is re-offered
              // for qualification whenever it actually changes — not
              // permanently quarantined under UNRESOLVED_WORK_ITEM_KEY the
              // first time it's seen, even after config or the PR itself
              // changes. appendEventEnvelope still dedups on eventId, so an
              // unchanged PR is only ever appended once per updated_at value.
              eventId: `pr-seen-${repoRef.replace(/[^a-z0-9]+/gi, '-')}-${pr.number}-${pr.updated_at}`,
              streamScope: 'global-intake',
              direction: 'inbound',
              sourceSystem: githubPrSource,
              sourceEventType: 'pr.seen',
              sourceRefs: { repo: repoRef, sourceUrl: pr.html_url, resourceUri },
              occurredAt: pr.updated_at,
              ingestedAt,
              trigger: 'context-only',
              payload: {
                pr: { number: pr.number, author: pr.user?.login ?? 'unknown', headRef: pr.head.ref },
              },
            }),
          );
        }
      } catch (error) {
        console.error(
          `[github-pr-activity-source] discovery failed for ${repoRef}, skipping this tick: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return events;
  }

  async function pollWatchedPr(
    resourceUri: string,
    ingestedAt: string,
  ): Promise<UnkeyedEventEnvelope[]> {
    if (!deps.config.sources.github.pullRequests.enabled) {
      return [];
    }

    const ref = repoAndNumberFromPrUri(resourceUri);
    if (ref === null) {
      return [];
    }

    const events: UnkeyedEventEnvelope[] = [];
    const perPage = deps.config.sources.github.pullRequests.commentPageSize;

    try {
      const comments = await deps.client.listComments(ref.owner, ref.repo, ref.number, perPage);
      for (const comment of comments) {
        events.push(
          createUnkeyedEventEnvelope({
            eventId: `pr-comment-${ref.repoRef}-${ref.number}-${comment.id}-${comment.updated_at}`,
            streamScope: 'work-item',
            direction: 'inbound',
            sourceSystem: githubPrSource,
            sourceEventType: 'pr.comment.created',
            sourceRefs: { repo: ref.repoRef, commentId: String(comment.id), sourceUrl: comment.html_url, resourceUri },
            occurredAt: comment.updated_at,
            ingestedAt,
            trigger: 'context-only',
            payload: {
              comment: {
                id: `pr-${comment.id}`,
                body: comment.body ?? '',
                author: { login: comment.user?.login ?? 'unknown' },
                createdAt: comment.created_at,
                updatedAt: comment.updated_at,
                resourceUri,
              },
            },
            derivedHints: { botAuthoredComment: isBotAuthored(comment, deps.selfLogin) },
          }),
        );
      }

      const reviews = await deps.client.listReviews(ref.owner, ref.repo, ref.number, perPage);
      for (const review of reviews) {
        // GitHub allows submitting a review (e.g. "Request changes" or
        // "Approve") with no comment text — skipping those entirely would
        // lose the state-change signal itself, not just a missing comment,
        // so a bare state marker is still emitted.
        const body = (review.body ?? '').trim();
        const submittedAt = review.submitted_at ?? ingestedAt;
        events.push(
          createUnkeyedEventEnvelope({
            eventId: `pr-review-${ref.repoRef}-${ref.number}-${review.id}`,
            streamScope: 'work-item',
            direction: 'inbound',
            sourceSystem: githubPrSource,
            sourceEventType: 'pr.review.created',
            sourceRefs: { repo: ref.repoRef, commentId: `review-${review.id}`, sourceUrl: review.html_url, resourceUri },
            occurredAt: submittedAt,
            ingestedAt,
            trigger: 'context-only',
            payload: {
              comment: {
                id: `pr-review-${review.id}`,
                body: body.length === 0 ? `[${review.state}]` : `[${review.state}] ${body}`,
                author: { login: review.user?.login ?? 'unknown' },
                createdAt: submittedAt,
                updatedAt: submittedAt,
                resourceUri,
              },
            },
            derivedHints: { botAuthoredComment: isBotAuthored(review, deps.selfLogin) },
          }),
        );
      }

      const reviewComments = await deps.client.listReviewComments(ref.owner, ref.repo, ref.number, perPage);
      const byId = new Map(reviewComments.map((c) => [c.id, c]));
      for (const comment of reviewComments) {
        const rootId = reviewThreadRootId(comment, byId);
        const threadUri = reviewThreadResourceUri(ref.repoRef, ref.number, rootId);
        events.push(
          createUnkeyedEventEnvelope({
            eventId: `pr-review-comment-${ref.repoRef}-${ref.number}-${comment.id}-${comment.updated_at}`,
            streamScope: 'work-item',
            direction: 'inbound',
            sourceSystem: githubPrSource,
            sourceEventType: 'pr.review-comment.created',
            sourceRefs: {
              repo: ref.repoRef,
              commentId: String(comment.id),
              sourceUrl: comment.html_url,
              resourceUri: threadUri,
              // The thread's own resourceUri is never registered on its own
              // (each thread is unique), so core falls back to resolving via
              // the owning PR when this misses the index on first sighting.
              parentResourceUri: resourceUri,
            },
            occurredAt: comment.updated_at,
            ingestedAt,
            trigger: 'context-only',
            payload: {
              comment: {
                id: `pr-review-comment-${comment.id}`,
                body: comment.body ?? '',
                author: { login: comment.user?.login ?? 'unknown' },
                createdAt: comment.created_at,
                updatedAt: comment.updated_at,
                resourceUri: threadUri,
                reviewThread: { path: comment.path, line: comment.line ?? comment.original_line ?? undefined },
              },
            },
            derivedHints: { botAuthoredComment: isBotAuthored(comment, deps.selfLogin) },
          }),
        );
      }
    } catch (error) {
      console.error(
        `[github-pr-activity-source] activity poll failed for ${resourceUri}, skipping this tick: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return events;
  }

  return {
    async pollEvents(input?: { watch: Array<{ resourceUri: string }> }): Promise<UnkeyedEventEnvelope[]> {
      const ingestedAt = deps.now().toISOString();
      const watched = (input?.watch ?? []).filter((ref) => ref.resourceUri.startsWith('github:pr:'));

      const discovered = await discoverPullRequests(ingestedAt);
      const activityBatches = await Promise.all(
        watched.map((ref) => pollWatchedPr(ref.resourceUri, ingestedAt)),
      );

      return [...discovered, ...activityBatches.flat()];
    },
    async deliverIntent(input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
      const resourceUri = input.event.sourceRefs.resourceUri;
      if (resourceUri === undefined) {
        throw new Error(`cannot deliver intent ${input.event.eventId}: missing sourceRefs.resourceUri`);
      }

      const publishedAt = deps.now().toISOString();

      if (resourceUri.startsWith('github:pr-review-thread:')) {
        const locator = resourceUri.split(':').slice(2).join(':');
        const match = /^([^/]+)\/([^#]+)#(\d+)\/rt_(\d+)$/.exec(locator);
        if (match === null) {
          throw new Error(`cannot deliver intent ${input.event.eventId}: malformed review-thread uri ${resourceUri}`);
        }
        const [, owner, repo, numberStr, rootIdStr] = match;
        if (owner === undefined || repo === undefined || numberStr === undefined || rootIdStr === undefined) {
          throw new Error(`cannot deliver intent ${input.event.eventId}: malformed review-thread uri ${resourceUri}`);
        }

        const response = await deps.client.replyToReviewComment(
          owner,
          repo,
          Number(numberStr),
          Number(rootIdStr),
          formatWakeComment(input.event.payload, await readControlPlaneUiUrl(deps.config.paths.wakeRoot)),
        );

        return [
          createEventEnvelope({
            eventId: `${input.event.eventId}-published`,
            workItemKey: input.event.workItemKey,
            streamScope: 'work-item',
            direction: 'outbound',
            sourceSystem: githubPrSource,
            sourceEventType: 'pr.review-comment.reply.published',
            sourceRefs: { resourceUri, sourceUrl: (response as { html_url?: string } | undefined)?.html_url },
            occurredAt: publishedAt,
            ingestedAt: publishedAt,
            trigger: 'context-only',
            payload: { intentEventId: input.event.eventId, kind: input.event.payload.kind, body: input.event.payload.body },
          }),
        ];
      }

      const ref = repoAndNumberFromPrUri(resourceUri);
      if (ref === null) {
        throw new Error(`cannot deliver intent ${input.event.eventId}: malformed pr uri ${resourceUri}`);
      }

      await deps.client.createComment(
        ref.owner,
        ref.repo,
        ref.number,
        formatWakeComment(input.event.payload, await readControlPlaneUiUrl(deps.config.paths.wakeRoot)),
      );
      return [
        createEventEnvelope({
          eventId: `${input.event.eventId}-published`,
          workItemKey: input.event.workItemKey,
          streamScope: 'work-item',
          direction: 'outbound',
          sourceSystem: githubPrSource,
          sourceEventType: 'pr.comment.reply.published',
          sourceRefs: { repo: ref.repoRef, resourceUri },
          occurredAt: publishedAt,
          ingestedAt: publishedAt,
          trigger: 'context-only',
          payload: { intentEventId: input.event.eventId, kind: input.event.payload.kind, body: input.event.payload.body },
        }),
      ];
    },
  };
}
