import type { ProblemDetails } from './contracts/common.js';

export function problemDetails(
  status: number,
  title: string,
  detail?: string,
  extensions: Record<string, unknown> = {},
): ProblemDetails {
  return {
    type: `https://wake.atolis.dev/problems/${status}`,
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    ...extensions,
  };
}
