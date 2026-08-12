import {
  ControlStreamKind,
  ineligibleRunners,
  type ControlPlaneView,
} from '../control-plane/index.js';
import type { RunView } from '../execution/index.js';
import type { WorkflowInstanceView } from '../orchestration/index.js';
import { ApiCommandStatus, presentRun, type ApiApplications } from '../surfaces/index.js';
import type { CompositionRoot } from './composition-root.js';
import { projectionMeta, sampledMeta } from './surface-api-metadata.js';
import { projectionPage } from './surface-api-projection-pages.js';
import { withWorkflowContext } from './surface-api-run-context.js';
import { readWorkTranscript } from './surface-api-transcripts.js';

export function createExecutionApplications(
  root: CompositionRoot,
  now: () => string,
): ApiApplications['execution'] {
  return {
    async pauseRunner(runnerId, command) {
      await root.runnerControls.pause(runnerId, command.idempotencyKey);
      return commandAccepted(command, now());
    },
    async unpauseRunner(runnerId, command) {
      await root.runnerControls.unpause(runnerId, command.idempotencyKey);
      return commandAccepted(command, now());
    },
    async list(query) {
      const stored = (
        await root.projections.list<{ readonly view: RunView | null }>('execution')
      ).flatMap((entry) =>
        entry.value.view === null ? [] : [{ ...entry, value: entry.value.view }],
      );
      const filtered = stored.filter(
        (entry) => query.state === undefined || entry.value.status === query.state,
      );
      const page = await projectionPage(root.journal, filtered, query, presentRun, {
        emptyAsOf: now(),
        provenance: stored,
      });
      return {
        ...page,
        items: await Promise.all(page.items.map((item) => withWorkflowContext(root, item))),
      };
    },
    async get(runId) {
      const stored = await root.projections.read<{ readonly view: RunView | null }>(
        'execution',
        runId,
      );
      if (stored?.value.view == null) return undefined;
      return {
        data: await withWorkflowContext(root, presentRun(stored.value.view)),
        meta: await projectionMeta(root.journal, [stored], now()),
      };
    },
    async transcript(runId) {
      const stored = await root.projections.read<{ readonly view: RunView | null }>(
        'execution',
        runId,
      );
      const run = stored?.value.view;
      if (run === null || run === undefined) return undefined;
      const workflow = await root.projections.read<{ readonly view: WorkflowInstanceView | null }>(
        'orchestration',
        run.workflowInstanceId,
      );
      const workItemId = workflow?.value.view?.workItemId;
      if (workItemId === undefined)
        return { data: { runId, available: false, entries: [] }, meta: sampledMeta(now()) };
      const groupId = await root.transcriptStore?.groupForRun(workItemId, runId);
      if (groupId === undefined)
        return { data: { runId, available: false, entries: [] }, meta: sampledMeta(now()) };
      const group = await readWorkTranscript(root.transcriptStore, workItemId, groupId, [run]);
      return {
        data: { runId, groupId, available: group.available, entries: group.entries },
        meta: sampledMeta(now()),
      };
    },
    async runners(query) {
      const sampledAt = now();
      const stored = await root.projections.read<ControlPlaneView>(
        ControlStreamKind.Global,
        'global',
      );
      const paused =
        stored === null ? new Set<string>() : ineligibleRunners(stored.value, sampledAt);
      const all = [...new Set(Object.values(root.config.execution.runnerPools).flat())].map(
        (runnerId) =>
          paused.has(runnerId)
            ? {
                runnerId,
                status: 'paused',
                available: false,
                detail: 'runner is paused',
                updatedAt: sampledAt,
              }
            : { runnerId, status: 'available', available: true, updatedAt: sampledAt },
      );
      const offset = query.cursor?.position ?? 0;
      const items = all.slice(offset, offset + query.limit);
      return {
        items,
        total: all.length,
        meta: sampledMeta(sampledAt),
        ...(offset + items.length < all.length ? { nextPosition: offset + items.length } : {}),
      };
    },
  };
}

function commandAccepted(command: { readonly idempotencyKey: string }, acceptedAt: string) {
  return {
    commandId: `runner:${command.idempotencyKey}`,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    status: ApiCommandStatus.Completed,
  };
}
