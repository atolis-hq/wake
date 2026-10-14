import {
  MergeStageApprovalGuidance,
  MergeWaitGuidance,
} from '../../application/terminal-agent-run-report.js';

export interface AgentRunComment {
  readonly idempotencyKey: string;
  readonly displayBody: string;
  readonly outcome: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED' | 'NEEDS_CLARIFICATION';
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
  readonly awaitingMerge?: boolean | undefined;
  readonly mergeStageApproval?: boolean | undefined;
  readonly watchGateVerdict?: { readonly runId: string } | undefined;
  readonly publicUiUrl?: string | undefined;
}

/** Names only the commands the current wait accepts. */
function waitHintFor(value: AgentRunComment): string | undefined {
  if (value.awaitingMerge === true) return `_${MergeWaitGuidance}_`;
  if (value.awaitingApproval !== true) return undefined;
  if (value.mergeStageApproval === true) return `_${MergeStageApprovalGuidance}_`;
  return '_An authorized independent reviewer can reply with /approved or /changes followed by feedback. Approval of your own work is not permitted. To ask a question, reply with /ask followed by your question._';
}

export function formatAgentRunComment(value: AgentRunComment): string {
  const details = detailsLine(value);
  const sections = [
    '<!-- wake:agent -->',
    `<!-- wake:delivery:${value.idempotencyKey} -->`,
    `**${wakeHeading(value.publicUiUrl)}** _(Wake${details ? ` - ${details}` : ''})_`,
    `**Outcome:** ${commentOutcome(value)}`,
    value.displayBody.trim() || fallback(value.outcome),
  ];
  const waitHint = waitHintFor(value);
  if (waitHint !== undefined) sections.push(waitHint);
  if (hasContinuationHint(value))
    sections.push(
      value.outcome === 'NEEDS_CLARIFICATION'
        ? '_Reply with the requested clarification. A maintainer with repository write, maintain, or admin permission can also use /changes followed by instructions to continue eligible blocked work._'
        : '_A maintainer with repository write, maintain, or admin permission can continue eligible blocked work with /changes followed by instructions, including on an issue they authored. The authenticated UI also offers Continue with instructions. /retry is for eligible failed stages._',
    );
  if (value.outcome === 'FAILED' && value.awaitingMerge !== true)
    sections.push(
      '_An authorized maintainer can use /retry for an eligible failed stage, or /restart for a fresh session. These commands do not continue a blocked outcome._',
    );
  const session = sessionSection(value);
  if (session !== undefined) sections.push(session);
  const marker = watchGateMarkerSection(value);
  if (marker !== undefined) sections.push(marker);
  return sections.join('\n\n');
}

function wakeHeading(publicUiUrl: string | undefined): string {
  return publicUiUrl === undefined ? 'Wake' : `[Wake](${publicUiUrl})`;
}

function watchGateMarkerSection(value: AgentRunComment): string | undefined {
  if (value.watchGateVerdict === undefined) return undefined;
  const marker = {
    wake: {
      watchGateVerdict: {
        runId: value.watchGateVerdict.runId,
        outcome: value.outcome,
      },
    },
  };
  return ['```json', JSON.stringify(marker, null, 2), '```'].join('\n');
}

function detailsLine(value: AgentRunComment): string {
  const duration =
    value.startedAt === undefined || value.finishedAt === undefined
      ? undefined
      : formatDuration(new Date(value.finishedAt).getTime() - new Date(value.startedAt).getTime());
  return [
    value.stage && `stage \`${value.stage}\``,
    value.runner && `runner \`${value.runner}\``,
    value.runnerPool && `runnerPool \`${value.runnerPool}\``,
    value.cli && `cli ${value.cli}`,
    value.model && `model \`${value.model}\``,
    duration && `duration ${duration}`,
    tokens(value.metadata),
    cost(value.metadata),
    value.runId && `run \`${value.runId}\``,
  ]
    .filter(Boolean)
    .join(' - ');
}

function sessionSection(value: AgentRunComment): string | undefined {
  if (value.sessionId === undefined) return undefined;
  const resume =
    value.workspacePath === undefined
      ? `codex resume ${value.sessionId}`
      : `cd "${value.workspacePath}"\ncodex resume ${value.sessionId}`;
  return ['---', '_To inspect this exact Wake session locally:_', '```', resume, '```'].join('\n');
}

function outcome(value: AgentRunComment['outcome']) {
  return {
    DONE: '\u2705 Done',
    REJECTED: '\u{1F534} Changes Requested',
    BLOCKED: '\u{1F7E0} Blocked',
    FAILED: '\u274C Failed',
    NEEDS_CLARIFICATION: '\u{1F7E0} Needs clarification',
  }[value];
}

function fallback(value: AgentRunComment['outcome']) {
  return {
    DONE: 'Run completed.',
    REJECTED: 'Run rejected - needs changes.',
    BLOCKED: 'Run blocked - needs input.',
    FAILED: 'Run failed.',
    NEEDS_CLARIFICATION: 'Run blocked - needs input.',
  }[value];
}

function tokens(metadata: AgentRunComment['metadata']) {
  const input = metadata.inputTokens,
    output = metadata.outputTokens;
  return typeof input === 'number' || typeof output === 'number'
    ? `tokens ${Number(input ?? 0) + Number(output ?? 0)}`
    : undefined;
}

function cost(metadata: AgentRunComment['metadata']) {
  return typeof metadata.costUsd === 'number' ? `cost $${metadata.costUsd.toFixed(2)}` : undefined;
}

function formatDuration(value: number) {
  return `${Math.max(0, Math.round(value / 1000))}s`;
}

function commentOutcome(value: AgentRunComment): string {
  if (value.awaitingMerge === true) return '⏳ Awaiting merge';
  return value.awaitingApproval === true ? '⏳ Awaiting approval' : outcome(value.outcome);
}

function hasContinuationHint(value: AgentRunComment): boolean {
  return (
    value.awaitingMerge !== true &&
    (value.outcome === 'BLOCKED' || value.outcome === 'NEEDS_CLARIFICATION')
  );
}
