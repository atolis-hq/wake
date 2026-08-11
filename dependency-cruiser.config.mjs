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
  orchestration: ['kernel', 'work', 'activities', 'execution'],
  execution: ['kernel', 'work', 'resources', 'activities'],
  'control-plane': ['kernel', 'work', 'resources', 'orchestration', 'execution'],
  integrations: ['kernel', 'work', 'resources', 'activities', 'orchestration', 'execution'],
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
// composition-root is the sole production composition point; since the
// integrations barrel must not re-export provider namespaces (provider-locality),
// it alone may reach a provider's own index.ts directly.
const internalBoundaryRules = modules.map((module) => ({
  name: `no-${module}-internals`,
  severity: 'error',
  from: {
    pathNot:
      module === 'integrations'
        ? [`^src/${module}/`, '^src/bootstrap/composition-root\\.ts$']
        : `^src/${module}/`,
  },
  to: { path: `^src/${module}/(?!index\\.ts$)` },
}));
// The exemption above lets composition-root reach a provider barrel; it must not
// become a licence to reach a provider's internals.
const compositionRootBarrelRule = {
  name: 'composition-root-provider-barrels-only',
  severity: 'error',
  comment: 'Bootstrap may import a provider barrel, never a module inside one.',
  from: { path: '^src/bootstrap/composition-root\\.ts$' },
  to: { path: '^src/integrations/(?!index\\.ts$)(?![^/]+/index\\.ts$)' },
};
const undeclaredDependencyRules = Object.entries(dependencyMap).map(([module, dependencies]) => ({
  name: `no-undeclared-${module}-dependency`,
  severity: 'error',
  from: { path: `^src/${module}/` },
  to: { path: `^src/(?!(?:${[module, ...dependencies].join('|')})/)` },
}));

export default {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-archive-imports',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^archive/legacy/' },
    },
    {
      name: 'kernel-has-no-domain-dependencies',
      severity: 'error',
      from: { path: '^src/kernel/' },
      to: { path: '^src/(?!kernel/)' },
    },
    {
      name: 'filesystem-io-stays-in-adapters',
      severity: 'error',
      from: {
        path: '^src/(?!persistence/|execution/infrastructure/(?:workspace/|transcripts\\.ts$)|bootstrap/|surfaces/web-host/)',
      },
      to: { path: '^node:fs' },
    },
    {
      name: 'browser-imports-only-surface-transport-contracts',
      severity: 'error',
      from: { path: '^src/surfaces/web/src/' },
      to: { path: '^src/(?!surfaces/(?:web/src/|api/contracts/))' },
    },
    {
      name: 'browser-has-no-node-runtime-dependencies',
      severity: 'error',
      from: { path: '^src/surfaces/web/src/' },
      to: { path: '^node:' },
    },
    ...internalBoundaryRules,
    compositionRootBarrelRule,
    ...undeclaredDependencyRules,
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(archive/legacy|dist|dist-next|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
