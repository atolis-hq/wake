import { describe, expect, it } from 'vitest';
import { PullRequestMergeability, PullRequestState } from '../../../src/activities/index.js';
import type {
  DeliveryCandidate,
  DeliveryMaintenance,
  DeliverySelection,
} from '../../../src/orchestration/contracts/delivery.js';
import {
  BaseMovement,
  DeliveryCompletion,
  IntegrationState,
  MaintenanceKind,
  MaintenanceReason,
} from '../../../src/orchestration/contracts/vocabulary.js';
import {
  currentSelection,
  type DeliveryFacts,
} from '../../../src/orchestration/domain/delivery-facts.js';
import {
  assessIntegration,
  type PullRequestObservation,
} from '../../../src/orchestration/domain/delivery-integration.js';
import {
  completionDecision,
  deliveryState,
} from '../../../src/orchestration/domain/delivery-qa.js';
import { workId } from '../../support/identities.js';

const sha = (char: string) => char.repeat(40);

interface Change {
  readonly child: string;
  readonly repository: string;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly baseRevision?: string;
}

const changes: Change[] = [
  { child: 'a1', repository: 'repo-a', branch: 'a1', base: 'integration-a', head: sha('1') },
  { child: 'a2', repository: 'repo-a', branch: 'a2', base: 'a1', head: sha('2') },
  { child: 'b1', repository: 'repo-b', branch: 'b1', base: 'integration-b', head: sha('3') },
];

function selection(items: readonly Change[] = changes): DeliverySelection {
  return {
    requestId: 'select-1',
    revision: 1,
    entries: items.map((item) => ({
      cohortId: 'cohort',
      assignmentId: item.child,
      childWorkItemId: workId(item.child),
      output: {
        name: 'delivery',
        reference: {
          workItemId: workId(item.child),
          resourceId: `pr-${item.child}`,
          repositoryResourceId: item.repository,
          revision: item.head,
          branch: item.branch,
          pullRequestBase: item.base,
          runId: `run-${item.child}`,
          ...(item.baseRevision === undefined ? {} : { baseRevision: item.baseRevision }),
        },
      },
    })),
  };
}

function facts(
  overrides: Partial<DeliveryFacts> & { items?: readonly Change[] } = {},
): DeliveryFacts {
  const { items, ...rest } = overrides;
  return {
    reservations: [],
    results: [],
    consumed: new Map(),
    selections: [selection(items)],
    candidates: [],
    qa: [],
    maintenance: [],
    ...rest,
  };
}

const open = (
  head: string,
  extra: Partial<PullRequestObservation> = {},
): PullRequestObservation => ({
  state: PullRequestState.Open,
  headRevision: head,
  baseRevision: 'unknown',
  ...extra,
});

const merged = (head: string): PullRequestObservation => ({
  state: PullRequestState.Merged,
  headRevision: head,
  baseRevision: 'unknown',
});

function observe(entries: Record<string, PullRequestObservation>) {
  return new Map(Object.entries(entries));
}

const maintenance = (
  overrides: Partial<DeliveryMaintenance> & Pick<DeliveryMaintenance, 'maintenanceId'>,
): DeliveryMaintenance => ({
  target: { childWorkItemId: workId('a2'), outputName: 'delivery' },
  kind: MaintenanceKind.Rebase,
  resourceId: 'pr-a2',
  repositoryResourceId: 'repo-a',
  previous: { revision: sha('2'), pullRequestBase: 'a1' },
  current: { revision: sha('9'), pullRequestBase: 'integration-a' },
  producer: { runId: 'run-maintain', activationId: 'activation-maintain' },
  ...overrides,
});

describe('governed integration decisions', () => {
  const none = new Map<string, string>();

  it('orders the planned merges by repository and stack layer and offers only the first', () => {
    const result = assessIntegration(
      facts(),
      observe({ 'pr-a1': open(sha('1')), 'pr-a2': open(sha('2')), 'pr-b1': open(sha('3')) }),
      none,
    );
    expect(result.targets.map((target) => [target.output.childWorkItemId, target.layer])).toEqual([
      [workId('a1'), 0],
      [workId('a2'), 1],
      [workId('b1'), 0],
    ]);
    expect(result.next?.output.childWorkItemId).toBe(workId('a1'));
    expect(result.targets[1]?.state).toBe(IntegrationState.AwaitingLowerLayer);
    expect(result.complete).toBe(false);
  });

  it('requires agent maintenance after the first layer merges instead of merging the stack', () => {
    const result = assessIntegration(
      facts(),
      observe({ 'pr-a1': merged(sha('1')), 'pr-a2': open(sha('2')), 'pr-b1': open(sha('3')) }),
      none,
    );
    const second = result.targets.find((target) => target.output.childWorkItemId === workId('a2'));
    expect(second).toMatchObject({
      state: IntegrationState.MaintenanceRequired,
      maintenance: MaintenanceReason.Retarget,
      evidenceAffected: true,
    });
    expect(result.next).toBeNull();
    expect(result.blocking?.output.childWorkItemId).toBe(workId('a2'));
    expect(result.summary).toContain('1/3 selected changes merged');
  });

  it('unblocks the next layer only on the new subject the agent produced', () => {
    const recorded = facts({ maintenance: [maintenance({ maintenanceId: 'retarget-a2' })] });
    const stale = assessIntegration(
      recorded,
      observe({ 'pr-a1': merged(sha('1')), 'pr-a2': open(sha('2')), 'pr-b1': open(sha('3')) }),
      none,
    );
    // The provider still shows the old head, so the recorded subject is not what is reviewable.
    expect(stale.blocking?.maintenance).toBe(MaintenanceReason.HeadMoved);
    const result = assessIntegration(
      recorded,
      observe({ 'pr-a1': merged(sha('1')), 'pr-a2': open(sha('9')), 'pr-b1': open(sha('3')) }),
      none,
    );
    expect(result.next?.output.childWorkItemId).toBe(workId('a2'));
    expect(result.next?.revision).toBe(sha('9'));
    expect(result.next?.pullRequestBase).toBe('integration-a');
  });

  it('keeps the earlier subject as history while the selection reads the newest', () => {
    const recorded = facts({ maintenance: [maintenance({ maintenanceId: 'retarget-a2' })] });
    const current = currentSelection(recorded)!.entries.find(
      (entry) => entry.childWorkItemId === workId('a2'),
    )!;
    expect(current.output.reference).toMatchObject({
      revision: sha('9'),
      pullRequestBase: 'integration-a',
      runId: 'run-maintain',
      workItemId: workId('a2'),
    });
    expect(recorded.selections[0]!.entries[1]!.output.reference).toMatchObject({
      revision: sha('2'),
      pullRequestBase: 'a1',
    });
  });

  it('does not credit unrelated base movement as progress and flags only the moved subject', () => {
    const items = changes.map((item) => ({ ...item, baseRevision: sha('0') }));
    const result = assessIntegration(
      facts({ items }),
      observe({
        'pr-a1': open(sha('1'), { baseRevision: sha('0') }),
        'pr-a2': open(sha('2'), { baseRevision: sha('0') }),
        'pr-b1': open(sha('3'), { baseRevision: sha('f') }),
      }),
      none,
    );
    const moved = result.targets.find((target) => target.output.childWorkItemId === workId('b1'))!;
    expect(moved).toMatchObject({
      state: IntegrationState.MaintenanceRequired,
      maintenance: MaintenanceReason.BaseMoved,
      baseMovement: BaseMovement.Unrelated,
      evidenceAffected: true,
    });
    expect(
      result.targets
        .filter((target) => target !== moved)
        .every((target) => !target.evidenceAffected),
    ).toBe(true);
  });

  it.each(['squash', 'merge', 'rebase'] as const)(
    'requires fresh evidence for a planned %s integration commit distinct from its source head',
    () => {
      const items: Change[] = [
        {
          child: 'a1',
          repository: 'repo-a',
          branch: 'a1',
          base: 'integration-a',
          head: sha('1'),
          baseRevision: sha('0'),
        },
        {
          child: 'a2',
          repository: 'repo-a',
          branch: 'a2',
          base: 'integration-a',
          head: sha('2'),
          baseRevision: sha('0'),
        },
      ];
      const result = assessIntegration(
        facts({ items }),
        observe({
          'pr-a1': { ...merged(sha('1')), mergeRevision: sha('e') },
          'pr-a2': open(sha('2'), { baseRevision: sha('e') }),
        }),
        none,
      );
      expect(result.next).toBeNull();
      expect(result.blocking).toMatchObject({
        state: IntegrationState.MaintenanceRequired,
        baseMovement: BaseMovement.PlannedProgress,
        evidenceAffected: true,
      });
      expect(result.blocking?.detail).toContain('selected sibling merged');
    },
  );

  it('does not credit unrelated movement after a sibling has merged', () => {
    const result = assessIntegration(
      facts({
        items: [changes[0]!, { ...changes[1]!, base: 'integration-a', baseRevision: sha('0') }],
      }),
      observe({
        'pr-a1': { ...merged(sha('1')), mergeRevision: sha('e') },
        'pr-a2': open(sha('2'), { baseRevision: sha('f') }),
      }),
      none,
    );
    expect(result.blocking).toMatchObject({
      baseMovement: BaseMovement.Unrelated,
      evidenceAffected: true,
    });
  });

  it('asks for maintenance when the provider head is not the recorded subject', () => {
    const result = assessIntegration(
      facts(),
      observe({ 'pr-a1': open(sha('a')), 'pr-a2': open(sha('2')), 'pr-b1': open(sha('3')) }),
      none,
    );
    expect(result.blocking).toMatchObject({
      state: IntegrationState.MaintenanceRequired,
      maintenance: MaintenanceReason.HeadMoved,
    });
  });

  it('asks for maintenance on a conflict even without any movement', () => {
    const result = assessIntegration(
      facts({ items: [changes[2]!] }),
      observe({
        'pr-b1': open(sha('3'), { mergeability: PullRequestMergeability.Conflicting }),
      }),
      none,
    );
    expect(result.blocking?.maintenance).toBe(MaintenanceReason.Conflict);
  });

  it('holds frozen, cancelled or deleted targets and refuses closed or unobserved ones', () => {
    const held = assessIntegration(
      facts({ items: [changes[0]!] }),
      observe({ 'pr-a1': open(sha('1')) }),
      new Map([[workId('a1'), 'Delivery work a1 is unavailable']]),
    );
    expect(held.blocking?.state).toBe(IntegrationState.Held);
    expect(held.next).toBeNull();
    expect(
      assessIntegration(
        facts({ items: [changes[0]!] }),
        observe({ 'pr-a1': { ...open(sha('1')), state: PullRequestState.Closed } }),
        none,
      ).blocking?.state,
    ).toBe(IntegrationState.Closed);
    expect(
      assessIntegration(facts({ items: [changes[0]!] }), observe({}), none).blocking?.state,
    ).toBe(IntegrationState.Unobserved);
  });

  it('is complete only when every selected change is merged at its reviewed head', () => {
    const done = assessIntegration(
      facts(),
      observe({ 'pr-a1': merged(sha('1')), 'pr-a2': merged(sha('2')), 'pr-b1': merged(sha('3')) }),
      none,
    );
    expect(done.complete).toBe(true);
    const unverified = assessIntegration(
      facts(),
      observe({ 'pr-a1': merged(sha('1')), 'pr-a2': merged(sha('f')), 'pr-b1': merged(sha('3')) }),
      none,
    );
    expect(unverified.complete).toBe(false);
    expect(unverified.summary).toContain('differs from the reviewed and tested subject');
    expect(assessIntegration(facts({ items: [] }), observe({}), none).complete).toBe(false);
  });
});

describe('maintenance and delivery currency', () => {
  const candidate: DeliveryCandidate = {
    candidateId: 'candidate-1',
    selectionRevision: 1,
    repositories: [
      {
        resourceId: 'repo-a',
        revision: sha('2'),
        pullRequestBase: 'integration-a',
        source: { kind: 'output', tip: { childWorkItemId: workId('a2'), outputName: 'delivery' } },
        contributions: [
          { childWorkItemId: workId('a1'), outputName: 'delivery' },
          { childWorkItemId: workId('a2'), outputName: 'delivery' },
        ],
      },
    ],
    subjects: [
      {
        childWorkItemId: workId('a1'),
        outputName: 'delivery',
        revision: sha('1'),
        pullRequestBase: 'integration-a',
      },
      {
        childWorkItemId: workId('a2'),
        outputName: 'delivery',
        revision: sha('2'),
        pullRequestBase: 'a1',
      },
    ],
    context: [],
    criteria: [],
  };
  const qa = {
    qaId: 'qa-1',
    candidateId: 'candidate-1',
    verdict: 'pass' as const,
    revisions: [{ resourceId: 'repo-a', revision: sha('2') }],
    environment: { available: true },
    findings: [],
    runId: 'run-qa',
    activationId: 'activation-qa',
  };
  const base = facts({ items: [changes[0]!, changes[1]!], candidates: [candidate], qa: [qa] });

  it('keeps the candidate and its QA current until a contributing subject changes', () => {
    expect(deliveryState(base)).toMatchObject({ candidateCurrent: true, qaEffective: true });
  });

  it('makes the candidate and QA historical when maintenance replaces a contributing subject', () => {
    const maintained = { ...base, maintenance: [maintenance({ maintenanceId: 'rebase-a2' })] };
    const state = deliveryState(maintained);
    expect(state.candidateCurrent).toBe(false);
    expect(state.qaEffective).toBe(false);
    expect(completionDecision(state, DeliveryCompletion.QaApproved).reason).toBe(
      'No current candidate has been recorded for the selection',
    );
    // The pre-maintenance verdict is retained as history.
    expect(maintained.qa).toHaveLength(1);
  });

  it('treats a retarget that keeps the same head as a new subject too', () => {
    const retargeted = {
      ...base,
      maintenance: [
        maintenance({
          maintenanceId: 'retarget-a2',
          kind: MaintenanceKind.Retarget,
          current: { revision: sha('2'), pullRequestBase: 'integration-a' },
        }),
      ],
    };
    expect(deliveryState(retargeted).candidateCurrent).toBe(false);
  });

  it('invalidates QA when only the immutable base revision changes', () => {
    const original = facts({
      items: [changes[0]!, changes[1]!].map((item) => ({ ...item, baseRevision: sha('0') })),
      candidates: [
        {
          ...candidate,
          subjects: candidate.subjects!.map((subject) => ({ ...subject, baseRevision: sha('0') })),
        },
      ],
      qa: [qa],
    });
    expect(deliveryState(original).candidateCurrent).toBe(true);
    const changed = {
      ...original,
      maintenance: [
        maintenance({
          maintenanceId: 'base-only',
          current: { revision: sha('2'), pullRequestBase: 'a1', baseRevision: sha('f') },
        }),
      ],
    };
    expect(deliveryState(changed).qaEffective).toBe(false);
    expect(
      deliveryState({ ...changed, candidates: [{ ...candidate, subjects: undefined }] })
        .qaEffective,
    ).toBe(false);
  });

  it('leaves unrelated candidates and outputs untouched', () => {
    const other = maintenance({
      maintenanceId: 'rebase-b1',
      target: { childWorkItemId: workId('b1'), outputName: 'delivery' },
      resourceId: 'pr-b1',
      repositoryResourceId: 'repo-b',
      previous: { revision: sha('3'), pullRequestBase: 'integration-b' },
    });
    const withB = facts({
      items: [changes[0]!, changes[1]!, changes[2]!],
      candidates: [candidate],
      qa: [qa],
      maintenance: [other],
    });
    // This candidate was not built from b1, so maintaining b1 does not invalidate its QA.
    expect(deliveryState(withB)).toMatchObject({ candidateCurrent: true, qaEffective: true });
  });

  it('completes a QA-approved parent without merging but holds a merge-required one (DC-24)', () => {
    const state = deliveryState(base);
    expect(completionDecision(state, DeliveryCompletion.QaApproved)).toEqual({ complete: true });
    expect(completionDecision(state, DeliveryCompletion.MergeRequired).complete).toBe(false);
    expect(
      completionDecision(state, DeliveryCompletion.MergeRequired, {
        complete: false,
        summary: '1/2 selected changes merged',
      }).reason,
    ).toContain('1/2 selected changes merged');
    expect(
      completionDecision(state, DeliveryCompletion.MergeRequired, {
        complete: true,
        summary: '2/2 selected changes merged',
      }),
    ).toEqual({ complete: true });
  });
});
