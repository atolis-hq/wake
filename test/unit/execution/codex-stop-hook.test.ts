import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectCodexTranscript,
  maxLiveHookRetryMs,
  verifyCodexSession,
} from '../../../src/execution/index.js';

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

  it('ignores a cell left unresolved in an earlier process before a resume boundary', () => {
    const staleSegment = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec', call_id: 'exec-stale', arguments: '{}' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-stale',
          output: 'Script running with cell ID 30\nWall time 11.0 seconds\nOutput:\n',
        },
      }),
    ];
    const resumeBoundary = JSON.stringify({
      type: 'turn_context',
      payload: { turn_id: 'turn-2' },
    });
    const currentSegment = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'wait-stale',
          arguments: '{"cell_id":"30"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'wait-stale',
          output: [
            {
              type: 'input_text',
              text: 'Script failed\nWall time 0.0 seconds\nOutput:\nScript error:\nexec cell 30 not found',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec', call_id: 'exec-2', arguments: '{}' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'exec-2', output: '{"exit_code":0}' },
      }),
    ];
    const transcript = [...staleSegment, resumeBoundary, ...currentSegment].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('does not treat polling a persistent interactive session as an unresolved background job', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'exec-1',
          input:
            'const r = load("web_checks");\nconst next = await tools.write_stdin({session_id:r.session_id,chars:"",yield_time_ms:30000,max_output_tokens:20000});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 5\nWall time 11.0 seconds\nOutput:\n',
        },
      }),
      JSON.stringify({ type: 'task_complete' }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('still blocks a genuine exec_command background job left unresolved', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'exec-1',
          input: 'const r = await tools.exec_command({cmd:"npm run verify",workdir:"/wake"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 5\nWall time 11.0 seconds\nOutput:\n',
        },
      }),
      JSON.stringify({ type: 'task_complete' }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 5 has no terminal exit_code'),
    });
  });

  function execCell(cellId: string) {
    return [
      JSON.stringify({
        timestamp: '2026-08-23T00:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec', call_id: 'exec-1', arguments: '{}' },
      }),
      JSON.stringify({
        timestamp: '2026-08-23T00:00:00.500Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: `Script running with cell ID ${cellId}\nWall time 11.0 seconds\nOutput:\n`,
        },
      }),
    ];
  }

  function hookRetry(timestamp: string) {
    return JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<hook_prompt hook_run_id="stop:0:x">unverified: ...</hook_prompt>',
          },
        ],
      },
    });
  }

  it('gives up forcing continuation once the elapsed-time backstop is reached, even if still unresolved', () => {
    const overBackstop = new Date(
      Date.parse('2026-08-23T00:00:01.000Z') + maxLiveHookRetryMs + 1,
    ).toISOString();
    const transcript = [
      ...execCell('5'),
      hookRetry('2026-08-23T00:00:01.000Z'),
      hookRetry(overBackstop),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('still blocks while elapsed time is under the backstop', () => {
    const underBackstop = new Date(
      Date.parse('2026-08-23T00:00:01.000Z') + maxLiveHookRetryMs - 1000,
    ).toISOString();
    const transcript = [
      ...execCell('5'),
      hookRetry('2026-08-23T00:00:01.000Z'),
      hookRetry(underBackstop),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 5 has no terminal exit_code'),
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

  it('allows an exec cell when its native wait result reaches the terminal output shape', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'exec-1',
          input: 'const r = await tools.exec_command({cmd:"sleep 20"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 3',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'wait-1',
          arguments: '{"cell_id":"3","yield_time_ms":30000}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'wait-1',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 5.6 seconds\nOutput:\n' },
            { type: 'input_text', text: '' },
          ],
        },
      }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('resolves the originating cell when a wrapper wait reaches the native terminal output shape', () => {
    const transcript = [
      sessionLineageTranscript('Script running with cell ID 43'),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'wait-wrapper',
          arguments: '{"cell_id":"43"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'wait-wrapper',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 5.6 seconds\nOutput:\n' },
            { type: 'input_text', text: '' },
          ],
        },
      }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('keeps a cell unresolved for a malformed native terminal output shape', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'exec-1',
          input: 'const r = await tools.exec_command({cmd:"sleep 20"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 3',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'wait-1',
          arguments: '{"cell_id":"3"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'wait-1',
          output: [{}, { type: 'input_text', text: '' }],
        },
      }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 3 has no terminal exit_code'),
    });
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

  it('resolves a pending exec cell through a literal write_stdin session lineage', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'exec-command',
          input: 'const result = await tools.exec_command({cmd:"npm run verify"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-command',
          output: 'Script running with cell ID 42',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'wait',
          call_id: 'wait-command',
          input: { cell_id: '42' },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'wait-command',
          output: '{"session_id":"generic-session-17"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'write-stdin',
          input:
            'const result = await tools.write_stdin({session_id:"generic-session-17",chars:"",yield_time_ms:30000});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'write-stdin',
          output: '{"exit_code":17}',
        },
      }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('resolves the originating cell when a write_stdin wrapper wait reports its exit code', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'exec-command',
          input: 'const result = await tools.exec_command({cmd:"npm run verify"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-command',
          output: 'Script running with cell ID 42',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'wait',
          call_id: 'wait-command',
          input: { cell_id: '42' },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'wait-command',
          output: '{"session_id":"generic-session-17"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'write-stdin',
          input:
            'const result = await tools.write_stdin({session_id:"generic-session-17",chars:"",yield_time_ms:30000});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'write-stdin',
          output: 'Script running with cell ID 43',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'wait-wrapper',
          arguments: '{"cell_id":"43"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'wait-wrapper',
          output: [{ type: 'input_text', text: '{"exit_code":0}' }],
        },
      }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('keeps the originating cell unresolved when a write_stdin wrapper wait reports legacy exit text', () => {
    const transcript = [
      sessionLineageTranscript('Script running with cell ID 43'),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'wait',
          call_id: 'wait-wrapper',
          input: { cell_id: '43' },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'wait-wrapper',
          output: 'Exit code: 0',
        },
      }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 42 has no terminal exit_code'),
    });
  });

  it('keeps a session-linked cell unresolved when write_stdin reports a legacy exit-code string', () => {
    const transcript = sessionLineageTranscript('Exit code: 1');

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 42 has no terminal exit_code'),
    });
  });

  it('keeps a session-linked cell unresolved when session_id is nested in write_stdin arguments', () => {
    const transcript = sessionLineageTranscript('{"exit_code":1}', {
      writeStdinInput:
        'const result = await tools.write_stdin({options:{session_id:"generic-session-17"},chars:""});',
    });

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 42 has no terminal exit_code'),
    });
  });

  it('resolves a pending cell through numeric session lineage', () => {
    const transcript = sessionLineageTranscript([{ type: 'input_text', text: '{"exit_code":1}' }], {
      waitOutput: [{ type: 'input_text', text: '{"session_id":85120}' }],
      writeStdinInput: 'const result = await tools.write_stdin({session_id:85120,chars:""});',
    });

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('keeps a cell unresolved for an empty-string session lineage', () => {
    const transcript = sessionLineageTranscript('{"exit_code":1}', {
      waitOutput: '{"session_id":""}',
      writeStdinInput: 'const result = await tools.write_stdin({session_id:"",chars:""});',
    });

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 42 has no terminal exit_code'),
    });
  });

  function sessionLineageTranscript(
    writeStdinOutput: unknown,
    options: {
      readonly writeStdinInput?: string;
      readonly waitOutput?: unknown;
    } = {},
  ) {
    return [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'exec-command',
          input: 'const result = await tools.exec_command({cmd:"npm run verify"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-command',
          output: 'Script running with cell ID 42',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'wait',
          call_id: 'wait-command',
          input: { cell_id: '42' },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'wait-command',
          output: options.waitOutput ?? '{"session_id":"generic-session-17"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'write-stdin',
          input:
            options.writeStdinInput ??
            'const result = await tools.write_stdin({session_id:"generic-session-17",chars:"",yield_time_ms:30000});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'write-stdin',
          output: writeStdinOutput,
        },
      }),
    ].join('\n');
  }

  it('fails closed for malformed structured telemetry', () => {
    expect(inspectCodexTranscript('{not json')).toEqual({
      decision: 'block',
      reason: expect.stringContaining('could not parse Codex structured telemetry'),
    });
  });

  it('fails closed when the post-run fallback cannot locate session telemetry', async () => {
    await expect(verifyCodexSession(undefined, 'session-1')).resolves.toMatchObject({
      decision: 'block',
      reason: expect.stringMatching(
        /^caught by post-run verification: unverified: could not confirm background command completion from Codex structured telemetry: could not locate Codex structured telemetry$/,
      ),
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
      reason: expect.stringMatching(
        /^caught by post-run verification: unverified: could not confirm background command completion from Codex structured telemetry: Codex cell 42/,
      ),
    });
  });

  it('stops retrying a cell the runtime has already discarded, without treating it as resolved', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'exec-1',
          input: 'const r = await tools.exec_command({cmd:"npm run build",workdir:"/wake"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 1\nWall time 17.0 seconds\nOutput:\n',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'wait-1',
          arguments: '{"cell_id":"1"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'wait-1',
          output: [
            {
              type: 'input_text',
              text: 'Script failed\nWall time 0.0 seconds\nOutput:\nScript error:\nexec cell 1 not found',
            },
          ],
        },
      }),
      JSON.stringify({ type: 'task_complete' }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({});
  });

  it('keeps retrying a different still-queryable cell even when another cell is confirmed discarded', () => {
    const goneCell = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec', call_id: 'exec-1', arguments: '{}' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script running with cell ID 1\nWall time 17.0 seconds\nOutput:\n',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'wait-1',
          arguments: '{"cell_id":"1"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'wait-1',
          output: [
            {
              type: 'input_text',
              text: 'Script failed\nWall time 0.0 seconds\nOutput:\nScript error:\nexec cell 1 not found',
            },
          ],
        },
      }),
    ];
    const stillPendingCell = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec', call_id: 'exec-2', arguments: '{}' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-2',
          output: 'Script running with cell ID 2\nWall time 11.0 seconds\nOutput:\n',
        },
      }),
    ];
    const transcript = [
      ...goneCell,
      ...stillPendingCell,
      JSON.stringify({ type: 'task_complete' }),
    ].join('\n');

    expect(inspectCodexTranscript(transcript)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('Codex cell 2 has no terminal exit_code'),
    });
  });
});
