const modules = [
  'kernel',
  'persistence',
  'work',
  'resources',
  'activities',
  'orchestration',
  'execution',
  'control-plane',
  'integrations',
  'surfaces',
  'bootstrap',
];
const dependencyMap = {
  kernel: [],
  persistence: ['kernel'],
  work: ['kernel'],
  resources: ['kernel', 'work'],
  activities: ['kernel', 'work', 'resources'],
  orchestration: ['kernel', 'work', 'activities'],
  execution: ['kernel', 'work', 'activities'],
  'control-plane': ['kernel', 'work', 'resources', 'orchestration', 'execution'],
  integrations: ['kernel', 'work', 'resources', 'activities', 'orchestration'],
  surfaces: [
    'kernel',
    'work',
    'resources',
    'activities',
    'orchestration',
    'execution',
    'control-plane',
    'integrations',
  ],
  bootstrap: [
    'kernel',
    'persistence',
    'work',
    'resources',
    'activities',
    'orchestration',
    'execution',
    'control-plane',
    'integrations',
    'surfaces',
  ],
};
const internalBoundaryRules = modules.map((module) => ({
  name: `no-${module}-internals`,
  severity: 'error',
  from: { pathNot: `^src-next/${module}/` },
  to: { path: `^src-next/${module}/(?!index\\.ts$)` },
}));
const undeclaredDependencyRules = Object.entries(dependencyMap).map(([module, dependencies]) => ({
  name: `no-undeclared-${module}-dependency`,
  severity: 'error',
  from: { path: `^src-next/${module}/` },
  to: { path: `^src-next/(?!(?:${[module, ...dependencies].join('|')})/)` },
}));

export default {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-legacy-imports',
      severity: 'error',
      from: { path: '^src-next/' },
      to: { path: '^src/' },
    },
    {
      name: 'kernel-has-no-domain-dependencies',
      severity: 'error',
      from: { path: '^src-next/kernel/' },
      to: { path: '^src-next/(?!kernel/)' },
    },
    {
      name: 'filesystem-io-stays-in-adapters',
      severity: 'error',
      from: {
        path: '^src-next/(?!persistence/|execution/infrastructure/(?:workspace/|transcripts\\.ts$)|bootstrap/)',
      },
      to: { path: '^node:fs' },
    },
    ...internalBoundaryRules,
    ...undeclaredDependencyRules,
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|dist-next|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.next.json' },
  },
};
