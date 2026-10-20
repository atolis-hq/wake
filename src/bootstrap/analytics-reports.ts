import type { EventJournal } from '@atolis-hq/eventing';
import {
  createRunBreakdownReport,
  createRunDurationReport,
  createRunOutcomesReport,
  createRunUsageReport,
  queryRunAnalytics,
} from '../execution/index.js';
import { reportWindow, type ReportDefinition, type ReportWindowId } from '../kernel/index.js';
import {
  DeliveryActivityMeasure,
  createDeliveryActivityReport,
  createWorkThroughputReport,
  queryDeliveryActivity,
  queryWorkCompletionSummary,
  readCompletionFacts,
} from '../orchestration/index.js';
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
    createDeliveryActivityReport(journal),
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
      // Root completion facts are read once and shared by both work-derived summaries.
      const completion = await readCompletionFacts(journal, query);
      const [runs, work, delivery] = await Promise.all([
        queryRunAnalytics(journal, query),
        queryWorkCompletionSummary(journal, query, completion),
        queryDeliveryActivity(journal, query, completion),
      ]);
      return {
        data: {
          window: query.window,
          ...runs.summary,
          ...work,
          acceptedChildResults: delivery.totals[DeliveryActivityMeasure.AcceptedChildResults] ?? 0,
          correctiveActivations:
            delivery.totals[DeliveryActivityMeasure.CorrectiveActivations] ?? 0,
        },
        meta: sampledMeta(collectedAt),
      };
    },
  };
}
