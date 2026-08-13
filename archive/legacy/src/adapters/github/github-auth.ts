import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

type ExecFileResult = {
  stdout: string | Buffer;
  stderr: string | Buffer;
};

export async function resolveGitHubToken(deps?: {
  execFile?: (file: string, args: string[]) => Promise<ExecFileResult>;
}): Promise<string> {
  try {
    const result = await (deps?.execFile ?? execFile)('gh', ['auth', 'token']);
    const token = String(result.stdout).trim();

    if (token.length === 0) {
      throw new Error('empty token');
    }

    return token;
  } catch (error) {
    throw new Error(
      `Failed to resolve GitHub token via gh auth token: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
