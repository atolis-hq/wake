import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { ApiClientContext } from '../src/api/context.js';
import { ObservabilityPage } from '../src/features/observability/observability.js';

const now = '2026-08-01T12:30:00.000Z';
const window = { id: '1d', from: '2026-07-31T12:30:00.000Z', to: now, bucketMs: 3_600_000 };
const definitions = [
  { id: 'run-outcomes-over-time', title: 'Run outcomes over time' },
  { id: 'another-report', title: 'Another report' },
];
const report = {
  report: definitions[0],
  window,
  series: [{ id: 'completed', title: 'Completed' }],
  totals: { completed: 0 },
  buckets: [{ from: window.from, to: now, values: { completed: 0 } }],
};
const summary = {
  window,
  runs: 0,
  completed: 0,
  blockedOrAwaitingApproval: 0,
  failed: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  medianRunDurationMs: null,
  workItemsDone: 0,
  medianEndToEndDurationMs: null,
};
const json = (data: unknown) =>
  new Response(JSON.stringify({ data, meta: { asOf: now } }), { status: 200 });
function mount(fetcher: typeof fetch) {
  const client = new WakeApiClient(fetcher);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ApiClientContext.Provider value={client}>
        <ObservabilityPage />
      </ApiClientContext.Provider>
    </QueryClientProvider>,
  );
}
afterEach(cleanup);

it('loads the selected report while tiles are pending and renders empty values without NaN', async () => {
  let finish!: (response: Response) => void;
  mount(async (input) => {
    const url = String(input);
    if (url.endsWith('/reports')) return json(definitions);
    if (url.includes('/summary?'))
      return new Promise((resolve) => {
        finish = resolve;
      });
    return json(report);
  });
  expect(await screen.findByRole('img', { name: 'Run outcomes over time' })).toBeTruthy();
  expect(screen.getByText('Loading summary…')).toBeTruthy();
  await act(async () => finish(json(summary)));
  expect(await screen.findByRole('group', { name: 'Total tokens' })).toBeTruthy();
  expect(within(screen.getByRole('group', { name: 'Total tokens' })).getByText('0')).toBeTruthy();
  expect(
    within(screen.getByRole('group', { name: 'Median run duration' })).getByText('No data'),
  ).toBeTruthy();
  expect(screen.queryByText(/NaN/)).toBeNull();
  expect(
    within(screen.getByRole('table', { name: 'Run outcomes over time by bucket' })).getByText('0'),
  ).toBeTruthy();
});

it('keeps successful tiles when the report fails and retries only the report', async () => {
  let calls = 0,
    summaries = 0;
  mount(async (input) => {
    const url = String(input);
    if (url.endsWith('/reports')) return json(definitions);
    if (url.includes('/summary?')) {
      summaries++;
      return json(summary);
    }
    calls++;
    if (calls === 1)
      return new Response(
        JSON.stringify({ type: 'about:blank', title: 'Report unavailable', status: 500 }),
        { status: 500 },
      );
    return json(report);
  });
  expect(await screen.findByText('Report unavailable')).toBeTruthy();
  expect(screen.getByRole('group', { name: 'Runs' })).toBeTruthy();
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Selected report' })).getByRole('button', {
      name: 'Retry',
    }),
  );
  expect(await screen.findByRole('img', { name: 'Run outcomes over time' })).toBeTruthy();
  expect(summaries).toBe(1);
});

it('keeps the report visible when the summary fails and retries only the summary', async () => {
  let calls = 0,
    reports = 0;
  mount(async (input) => {
    const url = String(input);
    if (url.endsWith('/reports')) return json(definitions);
    if (!url.includes('/summary?')) {
      reports++;
      return json(report);
    }
    calls++;
    if (calls === 1)
      return new Response(
        JSON.stringify({ type: 'about:blank', title: 'Summary unavailable', status: 500 }),
        { status: 500 },
      );
    return json(summary);
  });
  expect(await screen.findByText('Summary unavailable')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Run outcomes over time' })).toBeTruthy();
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Summary tiles' })).getByRole('button', {
      name: 'Retry',
    }),
  );
  expect(await screen.findByRole('group', { name: 'Runs' })).toBeTruthy();
  expect(reports).toBe(1);
});

it('cancels both obsolete requests on window and report changes', async () => {
  const requests: { url: string; signal: AbortSignal }[] = [];
  mount(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/reports')) return json(definitions);
    const signal = init!.signal!;
    requests.push({ url, signal });
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
    );
  });
  await waitFor(() => expect(requests).toHaveLength(2));
  fireEvent.change(screen.getByLabelText('Window'), { target: { value: '3d' } });
  await waitFor(() => expect(requests).toHaveLength(4));
  expect(requests.slice(0, 2).every(({ signal }) => signal.aborted)).toBe(true);
  expect(requests.slice(2).every(({ url }) => url.includes('window=3d'))).toBe(true);
  fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'another-report' } });
  await waitFor(() => expect(requests).toHaveLength(6));
  expect(requests.slice(2, 4).every(({ signal }) => signal.aborted)).toBe(true);
  expect(requests[5]?.url).toContain('another-report');
});

it('keeps today’s system counters available on a keyboard-accessible tab', async () => {
  const urls: string[] = [];
  mount(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/metrics'))
      return json({
        collectedAt: now,
        window: { days: 1, from: '2026-08-01', to: '2026-08-01' },
        values: { events: 12, workItems: 3, runs: 4 },
      });
    if (url.endsWith('/reports')) return json(definitions);
    return json(url.includes('/summary?') ? summary : report);
  });
  const tab = screen.getByRole('tab', { name: 'Reports' });
  fireEvent.keyDown(tab, { key: 'End' });
  const panel = screen.getByRole('tabpanel', { name: 'System activity' });
  expect(await within(panel).findByText('12')).toBeTruthy();
  expect(urls).toContain('/api/v1/observability/metrics?days=1');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'System activity' }));
});

it('shows whole-window counts and shares and switches all six dimensions', async () => {
  const breakdown = {
    report: { id: 'run-breakdowns-by-dimension', title: 'Run breakdowns by dimension' },
    window,
    total: 4,
    dimensions: ['Action', 'Stage', 'Runner', 'Model', 'Repository', 'Runner pool'].map(
      (title) => ({
        id: title.toLowerCase(),
        title,
        rows: [
          { value: `${title} value`, count: 3, share: 0.75 },
          { value: 'unknown', count: 1, share: 0.25 },
        ],
      }),
    ),
  };
  mount(async (input) => {
    const url = String(input);
    if (url.endsWith('/reports')) return json([breakdown.report]);
    return json(url.includes('/summary?') ? { ...summary, runs: 4 } : breakdown);
  });
  const table = await screen.findByRole('table', { name: 'Run breakdowns by dimension' });
  expect(within(table).getByText('75%')).toBeTruthy();
  expect(within(table).getByText('25%')).toBeTruthy();
  expect(within(table).getByText('unknown')).toBeTruthy();
  for (const title of ['Action', 'Stage', 'Runner', 'Model', 'Repository', 'Runner pool']) {
    fireEvent.change(screen.getByLabelText('Dimension'), {
      target: { value: title.toLowerCase() },
    });
    expect(within(table).getByText(`${title} value`)).toBeTruthy();
  }
});

it('loads, retries and displays an empty breakdown without non-finite shares', async () => {
  const descriptor = { id: 'run-breakdowns-by-dimension', title: 'Run breakdowns by dimension' };
  let finish!: (response: Response) => void;
  let calls = 0;
  mount(async (input) => {
    const url = String(input);
    if (url.endsWith('/reports')) return json([descriptor]);
    if (url.includes('/summary?')) return json(summary);
    if (++calls === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return json({
      report: descriptor,
      window,
      total: 0,
      dimensions: ['Action', 'Stage', 'Runner', 'Model', 'Repository', 'Runner pool'].map(
        (title) => ({
          id: title.toLowerCase(),
          title,
          rows: [],
        }),
      ),
    });
  });
  expect(await screen.findByText('Loading report…')).toBeTruthy();
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({ type: 'about:blank', title: 'Report unavailable', status: 500 }),
        { status: 500 },
      ),
    ),
  );
  expect(await screen.findByText('Report unavailable')).toBeTruthy();
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Selected report' })).getByRole('button', {
      name: 'Retry',
    }),
  );
  expect(await screen.findByText('No runs in this window')).toBeTruthy();
  expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
});

it('selects usage, switches windows, retries and renders separate token and cost scales', async () => {
  const descriptor = { id: 'token-and-cost-usage', title: 'Token and cost usage' };
  let finish!: (response: Response) => void;
  let calls = 0;
  const urls: string[] = [];
  mount(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/reports')) return json([...definitions, descriptor]);
    if (url.includes('/summary?')) return json(summary);
    if (!url.includes(descriptor.id)) return json(report);
    if (++calls === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return json({
      report: descriptor,
      window,
      series: [
        { id: 'total-tokens', title: 'Total tokens', unit: 'tokens' },
        { id: 'total-cost-usd', title: 'Total cost (USD)', unit: 'USD' },
      ],
      totals: { 'total-tokens': 0, 'total-cost-usd': 0 },
      buckets: [{ from: window.from, to: now, values: { 'total-tokens': 0, 'total-cost-usd': 0 } }],
    });
  });
  await screen.findByRole('img', { name: 'Run outcomes over time' });
  fireEvent.change(screen.getByLabelText('Report'), { target: { value: descriptor.id } });
  expect(await screen.findByText('Loading report…')).toBeTruthy();
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({ type: 'about:blank', title: 'Usage unavailable', status: 500 }),
        { status: 500 },
      ),
    ),
  );
  await screen.findByText('Usage unavailable');
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Selected report' })).getByRole('button', {
      name: 'Retry',
    }),
  );
  expect(await screen.findByRole('img', { name: 'Total tokens' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Total cost (USD)' })).toBeTruthy();
  expect(
    within(screen.getByRole('table', { name: 'Total cost (USD) by bucket' })).getByText('$0.0000'),
  ).toBeTruthy();
  expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Window'), { target: { value: '7d' } });
  await waitFor(() =>
    expect(urls.some((url) => url.includes('window=7d') && url.includes(descriptor.id))).toBe(true),
  );
});

it('formats non-zero usage like the tiles in legends, axes, tooltips and bucket tables', async () => {
  const descriptor = { id: 'token-and-cost-usage', title: 'Token and cost usage' };
  const cost = 0.1 + 0.2;
  const tokens = 12345;
  mount(async (input) => {
    const url = String(input);
    if (url.endsWith('/reports')) return json([descriptor]);
    if (url.includes('/summary?'))
      return json({ ...summary, totalTokens: tokens, totalCostUsd: cost });
    return json({
      report: descriptor,
      window,
      series: [
        { id: 'total-tokens', title: 'Total tokens', unit: 'tokens' },
        { id: 'total-cost-usd', title: 'Total cost (USD)', unit: 'USD' },
      ],
      totals: { 'total-tokens': tokens, 'total-cost-usd': cost },
      buckets: [
        { from: window.from, to: now, values: { 'total-tokens': tokens, 'total-cost-usd': cost } },
      ],
    });
  });
  const chart = await screen.findByRole('img', { name: 'Total cost (USD)' });
  expect(within(chart).getByText('$0.3000 USD')).toBeTruthy();
  expect(within(chart).getByText(`${window.from}: Total cost (USD) $0.3000`)).toBeTruthy();
  expect(chart.querySelector('rect')?.getAttribute('height')).toBe('180');
  expect(screen.getByText('Total cost (USD): $0.3000')).toBeTruthy();
  expect(
    within(screen.getByRole('table', { name: 'Total cost (USD) by bucket' })).getByText('$0.3000'),
  ).toBeTruthy();
  expect(
    within(screen.getByRole('group', { name: 'Total cost (USD)' })).getByText('$0.3000'),
  ).toBeTruthy();
  const formattedTokens = tokens.toLocaleString();
  expect(screen.getByText(`Total tokens: ${formattedTokens}`)).toBeTruthy();
  expect(
    within(screen.getByRole('table', { name: 'Total tokens by bucket' })).getByText(
      formattedTokens,
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole('group', { name: 'Total tokens' })).getByText(formattedTokens),
  ).toBeTruthy();
  expect(screen.queryByText(/0\.30000000000000004/)).toBeNull();
});

it.each([0, 2])(
  'loads, retries and explains throughput exclusions with %i completions',
  async (total) => {
    const descriptor = { id: 'work-item-throughput', title: 'Work item throughput' };
    let finish!: (response: Response) => void;
    let calls = 0;
    mount(async (input) => {
      const url = String(input);
      if (url.endsWith('/reports')) return json([descriptor]);
      if (url.includes('/summary?')) return json({ ...summary, workItemsDone: total });
      if (++calls === 1)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return json({
        ...report,
        report: descriptor,
        series: [{ id: 'work-items-done', title: 'Work items done', unit: 'work items' }],
        totals: { 'work-items-done': total },
        buckets: [{ from: window.from, to: now, values: { 'work-items-done': total } }],
        durationRows: [],
        excludedDurationCount: total,
      });
    });
    expect(await screen.findByText('Loading report…')).toBeTruthy();
    await act(async () =>
      finish(
        new Response(
          JSON.stringify({ type: 'about:blank', title: 'Throughput unavailable', status: 500 }),
          {
            status: 500,
          },
        ),
      ),
    );
    await screen.findByText('Throughput unavailable');
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Selected report' })).getByRole('button', {
        name: 'Retry',
      }),
    );
    expect(
      await screen.findByText(
        total === 0
          ? 'No completed work items in this window'
          : 'No valid work item durations in this window',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Duration rows exclude missing, invalid, or inconsistent timestamps/)
        .textContent,
    ).toContain(`Excluded: ${total}`);
    expect(
      within(screen.getByRole('group', { name: 'Work items done' })).getByText(String(total)),
    ).toBeTruthy();
    expect(screen.getByText(`Work items done: ${total}`)).toBeTruthy();
  },
);

it('renders throughput identity, UTC timestamps and newest-first duration rows', async () => {
  const descriptor = { id: 'work-item-throughput', title: 'Work item throughput' };
  mount(async (input) => {
    const url = String(input);
    if (url.endsWith('/reports')) return json([descriptor]);
    if (url.includes('/summary?')) return json({ ...summary, workItemsDone: 2 });
    return json({
      ...report,
      report: descriptor,
      totals: { completed: 2 },
      durationRows: [
        {
          id: 'new',
          title: 'New item',
          createdAt: window.from,
          completedAt: now,
          durationMs: 86400000,
        },
        {
          id: 'old',
          title: 'Old item',
          createdAt: window.from,
          completedAt: '2026-08-01T10:00:00.000Z',
          durationMs: 77400000,
        },
      ],
      excludedDurationCount: 0,
    });
  });
  const table = await screen.findByRole('table', { name: 'Work item durations' });
  const rows = within(table).getAllByRole('row');
  expect(rows[1]?.textContent).toContain('New item (new)');
  expect(rows[2]?.textContent).toContain('Old item (old)');
  expect(within(table).getByText(now)).toBeTruthy();
  expect(within(table).getByText(`${(86400).toLocaleString()} s`)).toBeTruthy();
});

it.each([0, 2])('loads and retries run duration with %i qualifying runs', async (count) => {
  const descriptor = { id: 'run-duration', title: 'Run duration' };
  let finish!: (response: Response) => void;
  let calls = 0;
  const statistics = { count, medianMs: count ? 2000 : null, averageMs: count ? 3000 : null };
  mount(async (input) => {
    const url = String(input);
    if (url.endsWith('/reports')) return json([descriptor]);
    if (url.includes('/summary?')) return json(summary);
    if (++calls === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return json({
      report: descriptor,
      window,
      statistics,
      groups: ['Action', 'Stage'].map((title) => ({
        id: title,
        title,
        rows: count ? [{ value: 'agent', ...statistics }] : [],
      })),
      buckets: [{ from: window.from, to: now, ...statistics }],
    });
  });
  expect(await screen.findByText('Loading report…')).toBeTruthy();
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({ type: 'about:blank', title: 'Duration unavailable', status: 500 }),
        { status: 500 },
      ),
    ),
  );
  await screen.findByText('Duration unavailable');
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Selected report' })).getByRole('button', {
      name: 'Retry',
    }),
  );
  expect(await screen.findByText(/Unfinished runs and runs without valid/)).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Run duration by Action' })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Run duration by Stage' })).toBeTruthy();
  const buckets = screen.getByRole('table', { name: 'Run duration over time' });
  expect(within(buckets).getByText(count ? '2 s' : 'No data', { selector: 'strong' })).toBeTruthy();
  if (!count) expect(screen.getByText('No valid run durations in this window')).toBeTruthy();
});
