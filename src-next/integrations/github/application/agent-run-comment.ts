export interface AgentRunComment {
  readonly idempotencyKey: string;
  readonly displayBody: string;
  readonly outcome: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly stage?: string | undefined;
  readonly runner?: string | undefined;
  readonly runnerPool?: string | undefined;
  readonly cli?: string | undefined;
  readonly model?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
  readonly runId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly workspacePath?: string | undefined;
  readonly awaitingApproval?: boolean | undefined;
}

export function formatAgentRunComment(value: AgentRunComment): string {
  const duration = value.startedAt === undefined || value.finishedAt === undefined
    ? undefined
    : formatDuration(new Date(value.finishedAt).getTime() - new Date(value.startedAt).getTime());
  const details = [
    value.stage && `stage \`${value.stage}\``,
    value.runner && `runner \`${value.runner}\``,
    value.runnerPool && `runnerPool \`${value.runnerPool}\``,
    value.cli && `cli ${value.cli}`,
    value.model && `model \`${value.model}\``,
    duration && `duration ${duration}`,
    tokens(value.metadata),
    cost(value.metadata),
    value.runId && `run \`${value.runId}\``,
  ].filter(Boolean).join(' - ');
  const sections = [
    '<!-- wake:agent -->',
    `<!-- wake:delivery:${value.idempotencyKey} -->`,
    `**Wake** _(Wake${details ? ` - ${details}` : ''})_`,
    `**Outcome:** ${value.awaitingApproval === true ? '⏳ Awaiting approval' : outcome(value.outcome)}`,
    value.displayBody.trim() || fallback(value.outcome),
  ];
  if (value.awaitingApproval === true) sections.push('_To approve this work, reply with /approved. To request changes, reply with /changes followed by your feedback. To ask a question without requesting changes, reply with /ask followed by your question._');
  if (value.outcome === 'BLOCKED') sections.push('_Reply on this thread to continue. To request changes instead, reply with /changes followed by your feedback._');
  if (value.sessionId !== undefined) sections.push(['---', '_Next steps: reply on this thread to continue, or resume this exact Wake session locally:_', '```', value.workspacePath === undefined ? `codex resume ${value.sessionId}` : `cd "${value.workspacePath}"\ncodex resume ${value.sessionId}`, '```'].join('\n'));
  return sections.join('\n\n');
}

function outcome(value: AgentRunComment['outcome']) {
  return { DONE: '\u2705 Done', REJECTED: '\u{1F534} Changes Requested', BLOCKED: '\u{1F7E0} Blocked', FAILED: '\u274C Failed' }[value];
}
function fallback(value: AgentRunComment['outcome']) {
  return { DONE: 'Run completed.', REJECTED: 'Run rejected - needs changes.', BLOCKED: 'Run blocked - needs input.', FAILED: 'Run failed.' }[value];
}
function tokens(metadata: AgentRunComment['metadata']) {
  const input = metadata.inputTokens, output = metadata.outputTokens;
  return typeof input === 'number' || typeof output === 'number' ? `tokens ${Number(input ?? 0) + Number(output ?? 0)}` : undefined;
}
function cost(metadata: AgentRunComment['metadata']) {
  return typeof metadata.costUsd === 'number' ? `cost $${metadata.costUsd.toFixed(2)}` : undefined;
}
function formatDuration(value: number) { return `${Math.max(0, Math.round(value / 1000))}s`; }
