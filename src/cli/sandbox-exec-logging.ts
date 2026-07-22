const ENV_SECRET_PATTERN =
  /([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY)[A-Za-z0-9_]*=)[^\s]+/gi;
const GITHUB_TOKEN_PATTERN = /(?:gho|ghp|github_pat)_[A-Za-z0-9_]+/g;

export function scrubSecrets(line: string): string {
  return line
    .replace(ENV_SECRET_PATTERN, '$1[REDACTED]')
    .replace(GITHUB_TOKEN_PATTERN, '[REDACTED]');
}
