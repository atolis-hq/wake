export const autoApprovalLabel = 'wake:auto';

const autoApprovalCommands = new Set(['yolo', 'autoapprove']);

export interface AutoApprovalIntent {
  kind: 'auto-approval-opt-in';
  label: typeof autoApprovalLabel;
  command: string;
}

export function resolveAutoApprovalIntent(body: string | undefined): AutoApprovalIntent | null {
  for (const line of (body ?? '').split(/\r?\n/)) {
    const match = /^\/([A-Za-z0-9_.-]+)\b/.exec(line.trim());
    const command = match?.[1]?.toLowerCase();
    if (command !== undefined && autoApprovalCommands.has(command)) {
      return {
        kind: 'auto-approval-opt-in',
        label: autoApprovalLabel,
        command,
      };
    }
  }

  return null;
}
