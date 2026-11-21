import { ActivityOutcomeKind } from '../../activities/index.js';
import type { CompiledOutcomeRoute } from '../contracts/config.js';
import { signalName, stageName } from '../contracts/identifiers.js';
import { TransitionTargetKind } from '../contracts/vocabulary.js';

export const isReservedRouteTarget = (target: string): boolean =>
  target === ActivityOutcomeKind.Done || target === 'await-human' || target === 'wait';

export const isReservedTerminalTarget = (target: string): boolean =>
  target === ActivityOutcomeKind.Done || target === 'await-human';

export function assertConcludesWorkRoute(
  route: { readonly then: string; readonly concludesWork?: boolean | undefined },
  routeId: string,
): void {
  if (route.concludesWork === true && route.then !== ActivityOutcomeKind.Done)
    throw new Error(`Route ${routeId} concludesWork is only valid with then: done`);
}

export function assertWaitRoute(
  route: {
    readonly then: string;
    readonly resourceTransitions?: unknown;
    readonly await?: unknown;
    readonly watchGates?: unknown;
  },
  outcomeKind: string,
): void {
  if (route.then !== 'wait') return;
  if (outcomeKind !== ActivityOutcomeKind.Done) throw new Error('then: wait is only valid on done');
  if (route.resourceTransitions === undefined)
    throw new Error('then: wait requires resourceTransitions');
  if (route.await !== undefined || route.watchGates !== undefined)
    throw new Error('then: wait cannot configure await or watchGates');
}

export function compileTarget(
  target: string,
  outcomeKind: string,
  concludesWork = false,
): CompiledOutcomeRoute['target'] {
  if (target === ActivityOutcomeKind.Done)
    return concludesWork
      ? { kind: TransitionTargetKind.Complete, concludesWork: true }
      : { kind: TransitionTargetKind.Complete };
  if (target === 'await-human')
    return { kind: TransitionTargetKind.AwaitSignal, signal: signalName(outcomeKind) };
  if (target === 'wait') return { kind: TransitionTargetKind.ResourceTransitionWait };
  return { kind: TransitionTargetKind.Stage, stage: stageName(target) };
}
