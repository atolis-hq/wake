/** A group-budget extension that cannot be applied; the operator-facing reason is the message. */
export class GroupBudgetExtensionIneligibleError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'GroupBudgetExtensionIneligibleError';
  }
}
