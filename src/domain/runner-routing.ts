import type { AgentAction, RunnerRouting, Stage, WakeConfig, WakeLedger } from './types.js';
import { defaultWorkflowName } from './workflows.js';

export function maxConfiguredRunnerTimeoutMs(config: WakeConfig): number {
  const activeRunnerNames = new Set(
    Object.values(config.tiers).flatMap((candidates) => candidates),
  );
  for (const workflow of Object.values(config.workflows)) {
    for (const stageRoute of Object.values(workflow.stages)) {
      if (stageRoute.runner !== undefined) {
        activeRunnerNames.add(stageRoute.runner);
      }
    }
  }
  for (const stageRoute of Object.values(config.stages)) {
    if (stageRoute.runner !== undefined) {
      activeRunnerNames.add(stageRoute.runner);
    }
  }

  const registryTimeouts = [...activeRunnerNames]
    .map((name) => config.runners[name])
    .map((entry) => (entry === undefined || entry.kind === 'fake' ? undefined : entry.timeoutMs))
    .filter((timeout): timeout is number => timeout !== undefined);

  return registryTimeouts.length > 0 ? Math.max(...registryTimeouts) : Infinity;
}

// How often an 'estimated' pause (exponential-backoff guess, not a reset time
// the CLI actually reported) gets a recovery probe: a real attempt let through
// early in case the guess overshot and quota actually reset sooner. 'reported'
// pauses (an actual reset time) are trusted for their full duration - no
// probing needed since we already know when they clear.
const recoveryProbeIntervalMs = 15 * 60_000;

function isRunnerPaused(input: { runnerName: string; ledger: WakeLedger | undefined; now: Date }): {
  paused: boolean;
  isProbe: boolean;
} {
  const health = input.ledger?.runners?.[input.runnerName];
  const pausedUntil = health?.pausedUntil;
  if (pausedUntil === undefined || Date.parse(pausedUntil) <= input.now.getTime()) {
    return { paused: false, isProbe: false };
  }

  if (health?.pausedUntilSource === 'estimated' && health.lastFailureAt !== undefined) {
    const sinceLastFailureMs = input.now.getTime() - Date.parse(health.lastFailureAt);
    if (sinceLastFailureMs >= recoveryProbeIntervalMs) {
      return { paused: false, isProbe: true };
    }
  }

  return { paused: true, isProbe: false };
}

/**
 * Resolves which named runner should execute a stage/action.
 *
 * A stage pinned directly to a runner (`stages[stage].runner`) has no
 * fallback list, so it always returns that runner regardless of health.
 * A stage routed through a `tier` walks the tier's ordered candidates and
 * skips any currently quota-paused per the ledger (#67 sideways fallback),
 * returning `null` only when every candidate in the tier is paused - callers
 * should treat that as "nothing to do this tick", not a config error. Once a
 * higher-priority candidate's pause expires, it is preferred again on the
 * next call, which is the "rotation" back to the primary runner.
 */
export function resolveRunnerRouting(input: {
  config: WakeConfig;
  stage: Stage;
  action: AgentAction;
  workflowName?: string;
  ledger?: WakeLedger;
  now?: Date;
}): RunnerRouting | null {
  const workflowName = input.workflowName ?? defaultWorkflowName(input.config);
  const workflow = input.config.workflows[workflowName];
  if (workflow === undefined) {
    throw new Error(`Unknown workflow "${workflowName}".`);
  }
  const stageRoute = workflow.stages[input.stage];

  if (stageRoute?.runner !== undefined) {
    const entry = input.config.runners[stageRoute.runner];
    if (entry === undefined) {
      throw new Error(`Stage ${input.stage} pins unknown runner "${stageRoute.runner}".`);
    }
    return {
      runnerName: stageRoute.runner,
      runnerKind: entry.kind,
      ...(stageRoute.tier === undefined ? {} : { tier: stageRoute.tier }),
      reason: `stage ${input.stage} pins runner ${stageRoute.runner}`,
    };
  }

  const tier = stageRoute?.tier ?? input.config.defaultTier;
  const candidates = input.config.tiers[tier];
  if (candidates === undefined || candidates.length === 0) {
    throw new Error(`Stage ${input.stage} routes to unknown or empty tier "${tier}".`);
  }

  const now = input.now ?? new Date();
  let selected: { runnerName: string; isProbe: boolean } | undefined;
  for (const candidate of candidates) {
    const status = isRunnerPaused({ runnerName: candidate, ledger: input.ledger, now });
    if (!status.paused) {
      selected = { runnerName: candidate, isProbe: status.isProbe };
      break;
    }
  }
  if (selected === undefined) {
    return null;
  }

  const { runnerName, isProbe } = selected;
  const entry = input.config.runners[runnerName];
  if (entry === undefined) {
    throw new Error(`Tier ${tier} references unknown runner "${runnerName}".`);
  }

  const isFallback = runnerName !== candidates[0];

  return {
    runnerName,
    runnerKind: entry.kind,
    tier,
    reason: isProbe
      ? `tier ${tier} recovery probe on ${runnerName} (estimated pause not yet elapsed)`
      : isFallback
        ? `tier ${tier} fell back to ${runnerName} (higher-priority candidates paused)`
        : stageRoute?.tier === undefined
          ? `defaultTier ${tier} selected runner ${runnerName}`
          : `stage ${input.stage} tier ${tier} selected runner ${runnerName}`,
  };
}
