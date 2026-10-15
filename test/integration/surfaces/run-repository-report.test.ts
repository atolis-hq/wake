import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { createAnalyticsReports } from '../../../src/bootstrap/analytics-reports.js';
import { resolveResourceRepositoryIdentity } from '../../../src/bootstrap/composition-root.js';
import { ExecutionEventType, runId, runStream } from '../../../src/execution/index.js';
import { ReportWindowId, type BreakdownReport } from '../../../src/kernel/index.js';
import {
  OrchestrationEventType,
  workflowInstanceId,
  workflowInstanceStream,
} from '../../../src/orchestration/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  ResourceEventType,
  resourceStream,
} from '../../../src/resources/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { resId, workId } from '../../support/identities.js';

const now = '2026-08-01T12:30:00.000Z';
it('correlates production-shaped GitHub issue and PR facts, selecting one repository per run', async () => {
  const journal = new InMemoryEventJournal({ now: () => new Date(now) });
  let position = 0;
  for (const [index, sources] of [
    [{ id: 'issue', kind: BuiltInResourceKind.Issue, key: 'org/issue-repo#12' }],
    [
      { id: 'z-pr', kind: BuiltInResourceKind.PullRequest, key: 'org/z#13' },
      { id: 'a-pr', kind: BuiltInResourceKind.PullRequest, key: 'org/a#14' },
      { id: 'earlier-issue', kind: BuiltInResourceKind.Issue, key: 'org/ignored#15' },
    ],
    [{ id: 'bad', kind: BuiltInResourceKind.Issue, key: 'invalid' }],
    [],
  ].entries()) {
    const workflow = workflowInstanceStream(workflowInstanceId(`workflow-${index}`));
    await journal.appendToStream(workflow, 0, [
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: workId(`work-${index}`),
          workflowName: 'default',
          orchestrationGroupId: `group-${index}`,
          entry: 'implement',
        },
        workflow,
        ++position,
      ).event,
    ]);
    for (const source of sources) {
      const stream = resourceStream(resId(source.id));
      await journal.appendToStream(stream, 0, [
        eventEnvelope(
          ResourceEventType.ResourceDiscovered,
          {
            kind: source.kind,
            externalKey: { adapter: 'github', key: source.key },
            capabilities: [],
          },
          stream,
          ++position,
        ).event,
        eventEnvelope(
          ResourceEventType.WorkCorrelationEstablished,
          {
            workItemId: workId(`work-${index}`),
            role: ResourceCorrelationRole.Primary,
            provenance: ResourceCorrelationProvenance.ProviderObserved,
          },
          stream,
          ++position,
        ).event,
      ]);
    }
    const stream = runStream(runId(`run-${index}`));
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        index === 3 ? ExecutionEventType.RunPreparationStarted : ExecutionEventType.RunStarted,
        {
          activationId: `activation-${index}`,
          activity: 'agent',
          workflowInstanceId: workflow.id,
          orchestrationGroupId: `group-${index}`,
          attempt: 1,
          startedAt: '2026-08-01T12:00:00.000Z',
          ...(index === 3
            ? {}
            : { runner: { name: 'codex', pool: index === 0 ? 'pool-b' : 'pool-a' } }),
        },
        stream,
        ++position,
      ).event,
    ]);
  }
  const reports = createAnalyticsReports(journal, () => now, resolveResourceRepositoryIdentity);
  const result = await reports.report('run-breakdowns-by-dimension', ReportWindowId.Day);
  const report = result.data as BreakdownReport;
  expect(report.total).toBe((await reports.summary(ReportWindowId.Day)).data.runs);
  expect(report.total).toBe(4);
  for (const dimension of report.dimensions)
    expect(dimension.rows.reduce((sum, row) => sum + row.count, 0)).toBe(4);
  expect(report.dimensions.find(({ id }) => id === 'run-repository')?.rows).toEqual([
    { value: 'unknown', count: 2, share: 0.5 },
    { value: 'org/a', count: 1, share: 0.25 },
    { value: 'org/issue-repo', count: 1, share: 0.25 },
  ]);
  expect(report.dimensions.find(({ id }) => id === 'run-runner-pool')?.rows).toEqual([
    { value: 'pool-a', count: 2, share: 0.5 },
    { value: 'pool-b', count: 1, share: 0.25 },
    { value: 'unknown', count: 1, share: 0.25 },
  ]);
});
