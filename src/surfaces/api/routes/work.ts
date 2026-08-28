export const workRoutes = [
  '/api/v1/work-items',
  '/api/v1/work-items/:workItemKey',
  '/api/v1/work-items/:workItemKey/transcripts/:groupId',
  '/api/v1/work-items/:workItemKey/commands/freeze',
  '/api/v1/work-items/:workItemKey/commands/unfreeze',
  '/api/v1/work-items/:workItemKey/commands/delete',
  '/api/v1/work-items/:workItemKey/commands/retry',
  '/api/v1/work-items/:workItemKey/commands/extend',
  '/api/v1/work-items/:workItemKey/commands/message',
] as const;
