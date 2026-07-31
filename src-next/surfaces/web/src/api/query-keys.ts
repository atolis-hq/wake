export const queryKeys = {
  controlPlane: { status: ['controlPlane', 'status'] as const },
  work: {
    all: ['work'] as const,
    list: (search = '', state = '', cursor = '') =>
      ['work', 'list', search, state, cursor] as const,
    detail: (key: string) => ['work', 'detail', key] as const,
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
    list: (cursor = '') => ['events', 'list', cursor] as const,
  },
  observability: { metrics: ['observability', 'metrics'] as const },
  system: { health: ['systemHealth'] as const, configuration: ['systemConfiguration'] as const },
};
