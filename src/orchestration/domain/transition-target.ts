import { ActivityOutcomeKind } from '../../activities/index.js';
import type { CompiledOutcomeRoute } from '../contracts/config.js';
import { signalName, stageName } from '../contracts/identifiers.js';
import { TransitionTargetKind } from '../contracts/vocabulary.js';

export const isReservedRouteTarget = (target: string): boolean =>
  target === ActivityOutcomeKind.Done || target === 'await-human' || target === 'wait';

export const isReservedTerminalTarget = (target: string): boolean =>
  target === ActivityOutcomeKind.Done || target === 'await-human';

export function compileTarget(target: string, outcomeKind: string): CompiledOutcomeRoute['target'] {
  if (target === ActivityOutcomeKind.Done) return { kind: TransitionTargetKind.Complete };
  if (target === 'await-human')
    return { kind: TransitionTargetKind.AwaitSignal, signal: signalName(outcomeKind) };
  if (target === 'wait') return { kind: TransitionTargetKind.ResourceTransitionWait };
  return { kind: TransitionTargetKind.Stage, stage: stageName(target) };
}
