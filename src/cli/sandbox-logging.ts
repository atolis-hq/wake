import { join } from 'node:path';

import type { WakeConfig } from '../domain/types.js';

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '');
}

function toContainerPath(pathValue: string, hostWakeRoot: string, containerWakeRoot: string): string {
  const normalizedPath = normalizePath(pathValue);
  const normalizedHostRoot = normalizePath(hostWakeRoot);
  const normalizedContainerRoot = normalizePath(containerWakeRoot);

  if (normalizedPath === normalizedHostRoot) {
    return normalizedContainerRoot;
  }

  if (normalizedPath.startsWith(`${normalizedHostRoot}/`)) {
    return `${normalizedContainerRoot}${normalizedPath.slice(normalizedHostRoot.length)}`;
  }

  return normalizedPath;
}

export function buildSandboxLoggedCommand(input: {
  label: string;
  config: WakeConfig;
  wakeRoot: string;
  containerHomeRoot: string;
  command: string[];
  cwd?: string;
}): string[] {
  const env = [
    `WAKE_SANDBOX_LABEL=${input.label}`,
    `WAKE_SANDBOX_CONTAINER_WAKE_ROOT=${input.config.sandbox.containerMountPath}`,
    `WAKE_SANDBOX_PROMPTS_ROOT=${toContainerPath(
      input.config.paths.promptsRoot ?? join(input.wakeRoot, 'prompts'),
      input.wakeRoot,
      input.config.sandbox.containerMountPath,
    )}`,
    `WAKE_SANDBOX_CONTAINER_HOME=${input.config.sandbox.containerHomeMountPath}`,
    `WAKE_SANDBOX_HOST_WAKE_ROOT=${input.wakeRoot}`,
    `WAKE_SANDBOX_HOST_CONTAINER_HOME=${input.containerHomeRoot}`,
    `WAKE_SANDBOX_CONTAINER_MOUNT=${input.config.sandbox.containerMountPath}`,
    `WAKE_SANDBOX_CONTAINER_NAME=${input.config.sandbox.containerName}`,
    ...(input.cwd === undefined ? [] : [`WAKE_SANDBOX_CWD=${input.cwd}`]),
  ];

  return ['env', ...env, '/wake/docker/log-command.sh', '--', ...input.command];
}
