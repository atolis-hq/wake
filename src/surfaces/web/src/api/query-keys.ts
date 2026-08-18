export const queryKeys = {
  board: { list: (cursor = '') => ['board', 'list', cursor] as const },
  status: { get: ['status'] as const },
  controlPlane: { status: ['controlPlane', 'status'] as const },
  work: {
    all: ['work'] as const,
    list: (search = '', state = '', cursor = '') =>
      ['work', 'list', search, state, cursor] as const,
    detail: (key: string) => ['work', 'detail', key] as const,
    transcript: (key: string, groupId: string) => ['work', 'transcript', key, groupId] as const,
  },
  resources: { list: ['resources', 'list'] as const },
  orchestration: { list: ['orchestration', 'list'] as const },
  execution: {
    runs: ['execution', 'runs'] as const,
    runList: (cursor = '') => ['execution', 'runs', cursor] as const,
    run: (id: string) => ['execution', 'runDetail', id] as const,
    transcript: (id: string) => ['execution', 'transcript', id] as const,
    runners: ['execution', 'runners'] as const,
  },
  events: {
    all: ['events'] as const,
    list: (cursor = '', workItemKey = '') => ['events', 'list', cursor, workItemKey] as const,
  },
  observability: { metrics: (days: number) => ['observability', 'metrics', days] as const },
  system: {
    health: ['systemHealth'] as const,
    configuration: ['systemConfiguration'] as const,
    commands: ['systemCommands'] as const,
  },
};
