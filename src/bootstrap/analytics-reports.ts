import type { EventJournal } from '@atolis-hq/eventing';
import {
  createRunBreakdownReport,
  createRunDurationReport,
  createRunOutcomesReport,
  createRunUsageReport,
  queryRunAnalytics,
} from '../execution/index.js';
import { reportWindow, type ReportDefinition, type ReportWindowId } from '../kernel/index.js';
import { createWorkThroughputReport, queryWorkCompletionSummary } from '../orchestration/index.js';
import type { ResourceRepositoryIdentityResolver } from '../resources/index.js';
import { createRunRepositoryLookup } from './run-repository-lookup.js';
import { sampledMeta } from './surface-api-metadata.js';

export function createAnalyticsReports(
  journal: EventJournal,
  now: () => string,
  resolveIdentity?: ResourceRepositoryIdentityResolver,
) {
  const definitions: readonly ReportDefinition[] = [
    createRunOutcomesReport(journal),
    createRunBreakdownReport(journal, createRunRepositoryLookup(journal, resolveIdentity)),
    createRunUsageReport(journal),
    createWorkThroughputReport(journal),
    createRunDurationReport(journal),
  ];
  return {
    catalogue: () => definitions.map(({ id, title }) => ({ id, title })),
    async report(id: string, windowId: ReportWindowId, signal?: AbortSignal) {
      const definition = definitions.find((report) => report.id === id);
      if (definition === undefined) throw new Error('Unknown report');
      const collectedAt = now();
      return {
        data: await definition.query({
          window: reportWindow(windowId, collectedAt),
          ...(signal === undefined ? {} : { signal }),
        }),
        meta: sampledMeta(collectedAt),
      };
    },
    async summary(windowId: ReportWindowId, signal?: AbortSignal) {
      const collectedAt = now();
      const query = {
        window: reportWindow(windowId, collectedAt),
        ...(signal === undefined ? {} : { signal }),
      };
      const [runs, work] = await Promise.all([
        queryRunAnalytics(journal, query),
        queryWorkCompletionSummary(journal, query),
      ]);
      return {
        data: { window: query.window, ...runs.summary, ...work },
        meta: sampledMeta(collectedAt),
      };
    },
  };
}
