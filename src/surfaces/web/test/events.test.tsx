import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { ApiClientContext } from '../src/api/context.js';
import { queryKeys } from '../src/api/query-keys.js';
import {
  EventRow,
  EventsFeed,
  EventsPage,
  mergeBoundedEvents,
} from '../src/features/events/events.js';
describe('event rows', () => {
  afterEach(cleanup);
  it('renders the full event name and expands the complete event record', async () => {
    const user = userEvent.setup();
    const record = {
      ...event(1),
      type: 'work.item.transitioned.from.intake.to.implementation',
      correlationId: 'correlation-1',
      payload: { workItemId: 'work-a', nested: { ok: true } },
    };
    render(
      <ol>
        {' '}
        <EventRow record={record} />{' '}
      </ol>,
    );
    const summary = screen.getByRole('button', { name: /work\.item\.transitioned/ });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(record.type)).toBeTruthy();
    expect(screen.getByText('>')).toBeTruthy();
    await user.click(summary);
    expect(screen.getByText(/"nested": \{/)).toBeTruthy();
    expect(screen.getByText(/"correlationId": "correlation-1"/)).toBeTruthy();
    expect(screen.getByText('v')).toBeTruthy();
    expect(summary.getAttribute('aria-expanded')).toBe('true');
  });
});
describe('incremental event feed', () => {
  // Only the polling interval is faked so findBy* keeps using real timers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    const page = (document.scrollingElement ?? document.documentElement) as HTMLElement;
    dimensions(page, { clientHeight: 0, scrollHeight: 0 });
    page.scrollTop = 0;
  });
  it('buffers incoming records while paused and resumes in stable bounded order', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<EventsFeed records={[event(1)]} />);
    await user.click(screen.getByRole('button', { name: 'Pause live view' }));
    rerender(<EventsFeed records={[event(1), event(2)]} />);
    expect(screen.getByRole('button', { name: '1 new event' })).toBeTruthy();
    expect(screen.queryByText('event-2')).toBeNull();
    await user.click(screen.getByRole('button', { name: '1 new event' }));
    expect(screen.getByText('event-2')).toBeTruthy();
    expect(
      mergeBoundedEvents(
        Array.from({ length: 205 }, (_, index) => event(index)),
        [],
        200,
      ),
    ).toHaveLength(200);
  });
  it('shows initial records in live view even when the page is initially scrollable', () => {
    const page = document.scrollingElement ?? document.documentElement;
    dimensions(page as HTMLElement, { clientHeight: 100, scrollHeight: 300 });
    const { rerender } = render(<EventsFeed records={[]} />);
    rerender(<EventsFeed records={[event(1)]} />);
    expect(screen.getByText('event-1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause live view' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new event/ })).toBeNull();
  });
  it('resumes logical live updates without moving the viewport or selection', async () => {
    const { rerender } = render(<EventsFeed records={[event(1)]} />);
    const page = document.scrollingElement ?? document.documentElement;
    dimensions(page as HTMLElement, { clientHeight: 100, scrollHeight: 300 });
    (page as HTMLElement).scrollTop = 40;
    fireEvent.scroll(window);
    rerender(<EventsFeed records={[event(1), event(2), event(2)]} />);
    expect(screen.getByRole('button', { name: '1 new event' })).toBeTruthy();
    const selectedText = screen.getByText('event-1').firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.click(screen.getByRole('button', { name: 'Resume live view' }));
    expect(screen.getByText('event-2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new event/ })).toBeNull();
    expect((page as HTMLElement).scrollTop).toBe(40);
    expect(selection.toString()).toBe('event-1');
    expect(selection.anchorNode).toBe(selectedText);
    rerender(<EventsFeed records={[event(1), event(2), event(3)]} />);
    expect(screen.getByText('event-3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new event/ })).toBeNull();
    expect((page as HTMLElement).scrollTop).toBe(40);
    expect(selection.toString()).toBe('event-1');
    expect(selection.anchorNode).toBe(selectedText);
  });
  it('keeps polling the first page when hasMore is true and merges newer events', async () => {
    const requests: string[] = [];
    let newest = 2;
    const client = new WakeApiClient(async (input) => {
      const url = String(input);
      requests.push(url);
      const items = url.includes('cursor=') ? [event(1)] : [event(newest), event(newest - 1)];
      return new Response(
        JSON.stringify({
          items,
          page: { nextCursor: 'c_older', hasMore: true },
          meta: { asOf: '2026-07-31T10:00:00.000Z', position: newest },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client, queryClient);
    expect(await screen.findByText('event-2')).toBeTruthy();
    expect(requests).toEqual(['/api/v1/events']);
    newest = 3;
    await advancePolling();
    expect(await screen.findByText('event-3')).toBeTruthy();
    expect(screen.getByText('event-2')).toBeTruthy();
    expect(requests).toEqual(['/api/v1/events', '/api/v1/events']);
    expect(queryClient.isFetching({ queryKey: queryKeys.events.all })).toBe(0);
  });
  it('catches up a burst larger than one page by following nextCursor', async () => {
    const requests: string[] = [];
    let burst = false;
    const pages: Record<string, { items: number[]; next: string | null }> = {
      first: { items: [2, 1], next: 'c_old' },
      burst: { items: [10, 9], next: 'c1' },
      c1: { items: [8, 7, 6, 5, 4, 3], next: 'c2' },
      c2: { items: [2, 1], next: null },
    };
    const client = new WakeApiClient(async (input) => {
      const url = String(input);
      requests.push(url);
      const key = url.includes('cursor=') ? url.split('cursor=')[1]! : burst ? 'burst' : 'first';
      const page = pages[key] ?? { items: [], next: null };
      return new Response(
        JSON.stringify({
          items: page.items.map(event),
          page: { nextCursor: page.next, hasMore: page.next !== null },
          meta: { asOf: '2026-07-31T10:00:00.000Z', position: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client, queryClient);
    expect(await screen.findByText('event-2')).toBeTruthy();
    burst = true;
    await advancePolling();
    expect(await screen.findByText('event-10')).toBeTruthy();
    for (let position = 1; position <= 10; position += 1)
      expect(screen.getByText(`event-${position}`)).toBeTruthy();
    expect(requests.slice(1)).toEqual([
      '/api/v1/events',
      '/api/v1/events?cursor=c1',
      '/api/v1/events?cursor=c2',
    ]);
  });
  it('keeps the first-load cursor for Next page after polling and bounds the list', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    let poll = false;
    const client = new WakeApiClient(async (input) => {
      const url = String(input);
      requests.push(url);
      const range = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) => to - i);
      let items: number[];
      let next: string | null = 'c_first';
      let hasMore = true;
      if (url.includes('cursor=c_first')) {
        items = [1];
        next = null;
        hasMore = false;
      } else if (url.includes('cursor=c_poll')) items = range(51, 150);
      else if (poll) {
        items = range(151, 300);
        next = 'c_poll';
      } else items = [5, 4];
      return new Response(
        JSON.stringify({
          items: items.map(event),
          page: { nextCursor: next, hasMore },
          meta: { asOf: '2026-07-31T10:00:00.000Z', position: 300 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client, queryClient);
    expect(await screen.findByText('event-5')).toBeTruthy();
    poll = true;
    await advancePolling();
    expect(await screen.findByText('event-300')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(200);
    expect(screen.queryByText('event-5')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('event-1')).toBeTruthy();
    expect(requests.at(-1)).toBe('/api/v1/events?cursor=c_first');
  });
  it('does not poll historical pages', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    const client = new WakeApiClient(async (input) => {
      const url = String(input);
      requests.push(url);
      const older = url.includes('cursor=c_older');
      return new Response(
        JSON.stringify({
          items: [event(older ? 1 : 2)],
          page: { nextCursor: 'c_older', hasMore: !older },
          meta: { asOf: '2026-07-31T10:00:00.000Z', position: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client, queryClient);
    expect(await screen.findByText('event-2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('event-1')).toBeTruthy();
    expect(screen.queryByText('event-2')).toBeNull();
    await advancePolling();
    await advancePolling();
    expect(requests).toEqual(['/api/v1/events', '/api/v1/events?cursor=c_older']);
  });
  it('keeps live view at the top of a scrollable page', () => {
    const page = (document.scrollingElement ?? document.documentElement) as HTMLElement;
    dimensions(page, { clientHeight: 100, scrollHeight: 300 });
    page.scrollTop = 0;
    const { rerender } = render(<EventsFeed records={[event(1)]} />);
    fireEvent.scroll(window);
    rerender(<EventsFeed records={[event(1), event(2)]} />);
    expect(screen.getByText('event-2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new event/ })).toBeNull();
    page.scrollTop = 10;
    fireEvent.scroll(window);
    rerender(<EventsFeed records={[event(1), event(2), event(3)]} />);
    expect(screen.getByText('event-3')).toBeTruthy();
  });
  it('shows new events at the top without pausing, and buffers once scrolled down', () => {
    const page = (document.scrollingElement ?? document.documentElement) as HTMLElement;
    dimensions(page, { clientHeight: 100, scrollHeight: 300 });
    const { rerender } = render(<EventsFeed records={[event(1)]} />);
    rerender(<EventsFeed records={[event(1), event(2)]} />);
    expect(screen.getByText('event-2')).toBeTruthy();
    page.scrollTop = 100;
    fireEvent.scroll(window);
    rerender(<EventsFeed records={[event(1), event(2), event(3)]} />);
    expect(screen.queryByText('event-3')).toBeNull();
    expect(screen.getByRole('button', { name: '1 new event' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 new event' }));
    expect(screen.getByText('event-3')).toBeTruthy();
  });
});
async function advancePolling() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
}
function renderPage(client: WakeApiClient, queryClient: QueryClient) {
  render(
    <MemoryRouter initialEntries={['/events']}>
      <QueryClientProvider client={queryClient}>
        <ApiClientContext.Provider value={client}>
          <EventsPage />
        </ApiClientContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
const event = (position: number) => ({
  id: `event-${position}`,
  type: 'work.created',
  occurredAt: '2026-07-31T10:00:00.000Z',
  position,
});
function dimensions(
  element: HTMLElement,
  values: { readonly clientHeight: number; readonly scrollHeight: number },
) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: values.clientHeight },
    scrollHeight: { configurable: true, value: values.scrollHeight },
  });
}
