export type WorkflowInstanceId = string & { readonly __workflowInstanceId: unique symbol };
export const workflowInstanceId = (value: string): WorkflowInstanceId => {
  if (value.trim().length === 0) throw new Error('WorkflowInstance id must not be empty');
  return value as WorkflowInstanceId;
};
