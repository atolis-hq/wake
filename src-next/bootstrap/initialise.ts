import { initialiseWakeHome } from '../surfaces/index.js';

const config = `schemaVersion: 1
execution:
  agentRunners: { fake: { kind: fake } }
  runnerPools: { standard: [fake] }
  defaultRunnerPool: standard
controlPlane: {}
integrations: {}
surfaces: {}
host:
  sandbox:
    image: wake-sandbox
    imageRepository: wake-sandbox
    containerName: wake-sandbox
    wakeMountPath: /wake
    containerHomeMountPath: /home/wake
    start: { enabled: true }
    extraMounts: []
  development: {}
`;

/** Creates an immediately-valid, human-readable target Wake root. */
export async function initialiseWakeRoot(wakeRoot: string): Promise<{ readonly wakeRoot: string }> {
  await initialiseWakeHome(wakeRoot, {
    'config.yaml': config,
    'config.workflows.yaml': 'workflows: {}\n',
    'prompts/implement.md': '# Wake implementation\n\nWork on {{workItemId}}.\n',
    'SETUP.md': '# Wake setup\n\nConfigure runners and integrations in config.yaml.\n',
    'docker/Dockerfile': 'FROM node:24-bookworm-slim\nWORKDIR /wake\n',
  });
  return { wakeRoot };
}
