import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectCodexTranscript, verifyCodexSession } from '../../../src/execution/index.js';

describe('Codex Stop hook telemetry guard', () => {
  it('blocks the real structured exec/wait sequence when its final managed cell is unresolved', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec', call_id: 'exec-1', arguments: '{}' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 42\nWall time 11.0 seconds\nOutput:\n',
        },
      }),
      JSON.stringify({ type: 'task_complete' }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 42 has no terminal exit_code'),
    });
  });

  it('blocks the current custom-tool-call rollout shape when its exec cell is unresolved', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: {} },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 42\nWall time 11.0 seconds\nOutput:\n',
        },
      }),
      JSON.stringify({ type: 'task_complete' }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 42 has no terminal exit_code'),
    });
  });

  it('allows an exec cell when a later wait result records its exit code', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec', call_id: 'exec-1', arguments: '{}' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 42\nWall time 11.0 seconds\nOutput:\n',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'wait-1',
          arguments: '{"cell_id":"42"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'wait-1',
          output: [{ type: 'input_text', text: '{"exit_code":0}' }],
        },
      }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('accepts Codex’s structured terminal Exit code text for a later wait result', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: {} },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 42',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'wait',
          call_id: 'wait-1',
          input: { cell_id: '42' },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'wait-1', output: 'Exit code: 0' },
      }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('fails closed for malformed structured telemetry', () => {
    expect(inspectCodexTranscript('{not json')).toEqual({
      decision: 'block',
      reason: expect.stringContaining('could not parse Codex structured telemetry'),
    });
  });

  it('fails closed when the post-run fallback cannot locate session telemetry', async () => {
    await expect(verifyCodexSession(undefined, 'session-1')).resolves.toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('could not locate Codex structured telemetry'),
    });
  });

  it('uses the session-specific rollout for its post-run fallback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-codex-home-'));
    const directory = join(home, 'sessions', '2026', '08', '23');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'rollout-2026-08-23T00-00-00-session-1.jsonl'),
      [
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec', call_id: 'exec-1', arguments: '{}' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'exec-1',
            output: 'Script running with cell ID 42',
          },
        }),
      ].join('\n'),
    );

    await expect(verifyCodexSession(home, 'session-1')).resolves.toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 42'),
    });
  });
});
