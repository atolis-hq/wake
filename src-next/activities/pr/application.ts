import { PullRequestDenialCode } from './vocabulary.js';
import { ActivityResourceRole } from '../contracts/vocabulary.js';
import { type CommandContext, type EventJournal } from '../../kernel/index.js';
import {
  resourceStream,
  type ResourceService,
  type ResourceStreamRef,
} from '../../resources/index.js';
import { workItemStream, type WorkItemStreamRef, type WorkService } from '../../work/index.js';
import { ActivityEventType, type ActivityFactDraft } from '../contracts/events.js';
import { isReviewAuthorized } from '../review/authorization.js';
import type {
  AcceptReviewSignal,
  ObservePullRequest,
  PullRequestAuthorityInput,
  PullRequestAuthorityOptions,
  PullRequestResourceView,
  PullRequestView,
  RequestChangesSignal,
} from './contracts.js';
import {
  checksChanged,
  discovered,
  mergeAuthorized,
  mergeDenied,
  reviewAcceptanceSignalRecorded,
  reviewAccepted,
  reviewChangesRequested,
  reviewRejected,
  revisionChanged,
  stateChanged,
} from './event-drafts.js';
import { decidePullRequestAuthority } from './policy.js';
import { acceptedReviewSignalProjection, pullRequestProjection } from './projection.js';
import { isPullRequestLikeResource } from './capability.js';

export interface PullRequestService {
  observe(command: ObservePullRequest, context: CommandContext): Promise<PullRequestView>;
  acceptReviewSignal(command: AcceptReviewSignal, context: CommandContext): Promise<void>;
  requestChangesSignal(command: RequestChangesSignal, context: CommandContext): Promise<void>;
  authorizeMerge(
    workItemId: ObservePullRequest['workItemId'],
    context: CommandContext,
  ): Promise<boolean>;
  decideAuthority(
    workItemId: ObservePullRequest['workItemId'],
    options: PullRequestAuthorityOptions,
  ): Promise<ReturnType<typeof decidePullRequestAuthority>>;
  authorityInput(workItemId: ObservePullRequest['workItemId']): Promise<PullRequestAuthorityInput>;
  get(resourceId: ObservePullRequest['resourceId']): Promise<PullRequestView | null>;
}

export function createPullRequestService(
  journal: EventJournal,
  work: WorkService,
  resources: ResourceService,
): PullRequestService {
  return new JournalPullRequestService(journal, work, resources);
}

class JournalPullRequestService implements PullRequestService {
  constructor(
    private readonly journal: EventJournal,
    private readonly work: WorkService,
    private readonly resources: ResourceService,
  ) {}

  async get(resourceId: ObservePullRequest['resourceId']): Promise<PullRequestView | null> {
    const events = await this.journal.readStream(resourceStream(resourceId));
    return events.reduce(
      (view, event) => pullRequestProjection.project(view, event),
      pullRequestProjection.initial(resourceId),
    );
  }

  async observe(command: ObservePullRequest, context: CommandContext): Promise<PullRequestView> {
    if (!(await this.hasVerifiedPrimaryCorrelation(command)))
      throw new Error('Pull request lacks verified primary correlation');
    if ((await this.work.get(command.workItemId)) === null)
      throw new Error('Pull request WorkItem missing');

    const current = await this.get(command.resourceId);
    if (current === null) {
      await this.append(command.resourceId, discovered(command, context));
    } else {
      await this.appendObservationChanges(current, command, context);
    }
    const view = await this.get(command.resourceId);
    if (view === null) throw new Error('Pull request observation was not recorded');
    return view;
  }

  async acceptReviewSignal(command: AcceptReviewSignal, context: CommandContext): Promise<void> {
    const rejection = await this.reviewRejection(command.resourceId, command.revision);
    if (rejection !== null) {
      await this.append(command.resourceId, reviewRejected(command.resourceId, rejection, context));
      return;
    }
    const signal = reviewAcceptanceSignalRecorded(command, context);
    const outcome = isReviewAuthorized(command)
      ? reviewAccepted(command, context)
      : reviewRejected(command.resourceId, PullRequestDenialCode.UntrustedActor, context);
    await this.append(command.resourceId, [signal, outcome]);
  }

  async requestChangesSignal(
    command: RequestChangesSignal,
    context: CommandContext,
  ): Promise<void> {
    const rejection = await this.reviewRejection(command.resourceId, command.revision);
    await this.append(
      command.resourceId,
      rejection === null
        ? reviewChangesRequested(command, context)
        : reviewRejected(command.resourceId, rejection, context),
    );
  }

  async authorizeMerge(
    workItemId: ObservePullRequest['workItemId'],
    context: CommandContext,
  ): Promise<boolean> {
    const prior = await this.priorMergeDecision(context.commandId);
    if (prior !== null) return prior;
    const input = await this.authorityInput(workItemId);
    const decision = decidePullRequestAuthority(input);
    if (decision.allowed) {
      const stream = resourceStream(decision.resourceId);
      await this.appendStream(stream, mergeAuthorized(stream, decision.revision, context));
      return true;
    }
    const stream = denialStream(input, workItemId);
    await this.appendStream(stream, mergeDenied(stream, decision.reason, context));
    return false;
  }

  async decideAuthority(
    workItemId: ObservePullRequest['workItemId'],
    options: PullRequestAuthorityOptions,
  ): Promise<ReturnType<typeof decidePullRequestAuthority>> {
    return decidePullRequestAuthority(await this.authorityInput(workItemId), options);
  }

  private async appendObservationChanges(
    current: PullRequestView,
    command: ObservePullRequest,
    context: CommandContext,
  ): Promise<void> {
    if (
      current.headRevision !== command.headRevision ||
      current.baseRevision !== command.baseRevision
    )
      await this.append(command.resourceId, revisionChanged(command, context));
    if (current.state !== command.state)
      await this.append(command.resourceId, stateChanged(command, context));
    if (current.checks !== command.checks)
      await this.append(command.resourceId, checksChanged(command, context));
  }

  private async append(
    resourceId: ObservePullRequest['resourceId'],
    event: ActivityFactDraft | readonly ActivityFactDraft[],
  ): Promise<void> {
    const stream = resourceStream(resourceId);
    await this.appendStream(stream, event);
  }

  private async appendStream(
    stream: ResourceStreamRef | WorkItemStreamRef,
    event: ActivityFactDraft | readonly ActivityFactDraft[],
  ): Promise<void> {
    const events = Array.isArray(event) ? event : [event];
    await this.journal.append(stream, (await this.journal.readStream(stream)).length, events);
  }

  private async priorMergeDecision(commandId: string): Promise<boolean | null> {
    const events = await this.journal.readAll(0);
    if (
      events.some(
        (event) => event.eventId === `${commandId}:${ActivityEventType.PrMergeAuthorized}`,
      )
    )
      return true;
    return events.some(
      (event) => event.eventId === `${commandId}:${ActivityEventType.PrMergeDenied}`,
    )
      ? false
      : null;
  }

  private async hasVerifiedPrimaryCorrelation(command: ObservePullRequest): Promise<boolean> {
    const resource = await this.resources.get(command.resourceId);
    if (
      resource === null ||
      !isPullRequestLikeResource(resource.capabilities) ||
      resource.primaryCorrelationConflict !== undefined
    )
      return false;
    const correlations = await this.resources.correlations(command.resourceId);
    const primary = correlations.filter((value) => value.role === ActivityResourceRole.Primary);
    return primary.length === 1 && primary[0]?.workItemId === command.workItemId;
  }

  private async reviewRejection(
    resourceId: ObservePullRequest['resourceId'],
    revision: string,
  ): Promise<PullRequestDenialCode | null> {
    const resource = await this.resources.get(resourceId);
    const view = await this.get(resourceId);
    if (resource === null || !isPullRequestLikeResource(resource.capabilities) || view === null)
      return PullRequestDenialCode.MissingResource;
    const correlations = await this.resources.correlations(resourceId);
    if (
      resource.primaryCorrelationConflict !== undefined ||
      correlations.filter((value) => value.role === ActivityResourceRole.Primary).length !== 1
    )
      return PullRequestDenialCode.CorrelationConflict;
    return view.headRevision === revision ? null : PullRequestDenialCode.StaleApproval;
  }

  async authorityInput(
    workItemId: ObservePullRequest['workItemId'],
  ): Promise<PullRequestAuthorityInput> {
    const correlations = await this.resources.correlationsForWork(workItemId);
    const entries = await Promise.all(
      correlations.map(async ({ resourceId }) => this.resourceEntry(resourceId)),
    );
    const resources = entries.filter(isPresent);
    const pullRequests = (
      await Promise.all(resources.map(({ resource }) => this.get(resource.resourceId)))
    ).filter(isPresent);
    const acceptedSignals = (
      await Promise.all(resources.map(({ resource }) => this.acceptedSignals(resource.resourceId)))
    ).flat();
    return {
      work: await this.work.get(workItemId),
      resources,
      pullRequests,
      acceptedSignals,
    };
  }

  private async acceptedSignals(
    resourceId: ObservePullRequest['resourceId'],
  ): Promise<PullRequestAuthorityInput['acceptedSignals']> {
    const events = await this.journal.readStream(resourceStream(resourceId));
    return events.reduce(
      (view, event) => acceptedReviewSignalProjection.project(view, event),
      acceptedReviewSignalProjection.initial(resourceId),
    );
  }

  private async resourceEntry(
    resourceId: ObservePullRequest['resourceId'],
  ): Promise<PullRequestResourceView | null> {
    const resource = await this.resources.get(resourceId);
    if (resource === null) return null;
    return { resource, correlations: await this.resources.correlations(resourceId) };
  }
}

function isPresent<Value>(value: Value | null): value is Value {
  return value !== null;
}

function denialStream(
  input: PullRequestAuthorityInput,
  workItemId: ObservePullRequest['workItemId'],
): ResourceStreamRef | WorkItemStreamRef {
  const resource = input.resources.find((entry) =>
    isPullRequestLikeResource(entry.resource.capabilities),
  );
  return resource === undefined
    ? workItemStream(workItemId)
    : resourceStream(resource.resource.resourceId);
}
