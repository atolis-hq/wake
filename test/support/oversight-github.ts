import type { OversightGh } from '../../src/integrations/index.js';

/** Permanent provider fake: assignment can succeed before its response is lost. */
export class OversightGitHub {
  readonly calls: string[][] = [];
  readonly assignments = new Map<number, string[]>();
  readonly evidence = new Map<string, unknown>();
  interruptAssignment = false;
  edits = 0;
  readonly closed = new Set<number>();

  readonly gh: OversightGh = async (args) => {
    this.calls.push([...args]);
    if (args.join(' ') === 'api user') return JSON.stringify({ login: 'wake-agent' });
    if (args[0] === 'issue' && args[1] === 'edit') {
      this.edits++;
      this.assignments.set(Number(args[2]), ['wake-agent']);
      if (this.interruptAssignment) {
        this.interruptAssignment = false;
        throw new Error('Lost response after GitHub assignment');
      }
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'view' && args.at(-1) === 'assignees,state')
      return JSON.stringify({
        state: this.closed.has(Number(args[2])) ? 'CLOSED' : 'OPEN',
        assignees: (this.assignments.get(Number(args[2])) ?? []).map((login) => ({ login })),
      });
    const key = args.join(' ');
    if (!this.evidence.has(key)) throw new Error(`Unconfigured gh read: ${key}`);
    return JSON.stringify(this.evidence.get(key));
  };
}
