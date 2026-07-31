import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WakeApiClient } from '../src/api/client.js';
import { ApiClientContext } from '../src/api/context.js';
import { queryKeys } from '../src/api/query-keys.js';
import { EventsFeed, EventsPage, mergeBoundedEvents } from '../src/features/events/events.js';

describe('incremental event feed', () => {
  afterEach(cleanup);
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

  it('resumes logical live updates without moving the viewport or selection', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<EventsFeed records={[event(1)]} />);
    const feed = screen.getByRole('list');
    dimensions(feed, { clientHeight: 100, scrollHeight: 300 });
    feed.scrollTop = 40;
    fireEvent.scroll(feed);
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
    expect(feed.scrollTop).toBe(40);
    expect(selection.toString()).toBe('event-1');
    expect(selection.anchorNode).toBe(selectedText);

    rerender(<EventsFeed records={[event(1), event(2), event(3)]} />);
    expect(screen.getByText('event-3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new event/ })).toBeNull();
    expect(feed.scrollTop).toBe(40);
    expect(selection.toString()).toBe('event-1');
    expect(selection.anchorNode).toBe(selectedText);
  });

  it('navigates historical pages before applying the tail cursor to incremental polls', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    const client = new WakeApiClient(async (input) => {
      const url = String(input);
      requests.push(url);
      const historical = !url.includes('cursor=');
      const tail = url.includes('cursor=c_page2');
      const position = historical ? 1 : tail ? 2 : 3;
      return new Response(
        JSON.stringify({
          items: [event(position)],
          page: {
            nextCursor: historical ? 'c_page2' : tail ? 'c_tail' : 'c_new_tail',
            hasMore: historical,
          },
          meta: { asOf: '2026-07-31T10:00:00.000Z', position },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/events']}>
        <QueryClientProvider client={queryClient}>
          <ApiClientContext.Provider value={client}>
            <EventsPage />
          </ApiClientContext.Provider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('event-1')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('event-2')).toBeTruthy();
    expect(screen.queryByText('event-1')).toBeNull();
    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.events.all, type: 'active' }));

    expect(requests.slice(0, 2)).toEqual(['/api/v1/events', '/api/v1/events?cursor=c_page2']);
    expect(requests.slice(2).every((request) => request === '/api/v1/events?cursor=c_tail')).toBe(
      true,
    );
    expect(await screen.findByText('event-3')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('event-1')).toBeTruthy();
    expect(screen.queryByText('event-2')).toBeNull();
    expect(screen.queryByText('event-3')).toBeNull();
  });
});

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
