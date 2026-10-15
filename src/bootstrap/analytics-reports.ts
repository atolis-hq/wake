import type { EventJournal } from '@atolis-hq/eventing';
import {
  createRunBreakdownReport,
  createRunOutcomesReport,
  createRunUsageReport,
  queryRunAnalytics,
} from '../execution/index.js';
import { reportWindow, type ReportDefinition, type ReportWindowId } from '../kernel/index.js';
import { queryWorkCompletionSummary } from '../orchestration/index.js';
import { sampledMeta } from './surface-api-metadata.js';

export function createAnalyticsReports(journal: EventJournal, now: () => string) {
  const definitions: readonly ReportDefinition[] = [
    createRunOutcomesReport(journal),
    createRunBreakdownReport(journal),
    createRunUsageReport(journal),
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
