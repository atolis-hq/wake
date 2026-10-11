import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { ApiClientContext } from '../src/api/context.js';
import { MarkdownArtifactViewer } from '../src/features/work/markdown-artifact-viewer.js';

afterEach(cleanup);

function viewer(response: () => Promise<Response>) {
  const close = vi.fn();
  const fetcher = vi.fn<typeof fetch>(response);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiClientContext.Provider value={new WakeApiClient(fetcher)}>
        <MarkdownArtifactViewer
          workItemKey="wk_a"
          artifact={{
            revisionId: 'revision-1',
            path: 'plan.md',
            href: '/api/v1/work-items/wk_a/artifacts/revision-1',
          }}
          onClose={close}
        />
      </ApiClientContext.Provider>
    </QueryClientProvider>,
  );
  return { close, fetcher };
}

describe('Markdown artifact viewer', () => {
  it('renders formatting safely, retains download and closes', async () => {
    const { close, fetcher } = viewer(
      async () =>
        new Response(
          '# Plan\n\n**Important**\n\n- Step one\n\n```ts\nconst value = 1;\n```\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert%281%29)',
        ),
    );
    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeTruthy();
    expect(screen.getByText('Important').tagName).toBe('STRONG');
    expect(screen.getByText('Step one').tagName).toBe('LI');
    expect(screen.getByText('const value = 1;').tagName).toBe('CODE');
    expect(document.querySelector('article script, article img')).toBeNull();
    expect(screen.getByText('unsafe').getAttribute('href') ?? '').toBe('');
    expect(screen.getByRole('link', { name: 'Download plan.md' }).getAttribute('href')).toBe(
      '/api/v1/work-items/wk_a/artifacts/revision-1',
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/work-items/wk_a/artifacts/revision-1');
    await userEvent.click(screen.getByRole('button', { name: 'Back to artifacts' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['http', 'network'])('keeps navigation available on a %s failure', async (failure) => {
    const { close } = viewer(async () => {
      if (failure === 'network') throw new Error('Network unavailable');
      return new Response('', { status: 404 });
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Back to artifacts' }));
    expect(close).toHaveBeenCalledOnce();
  });
});
