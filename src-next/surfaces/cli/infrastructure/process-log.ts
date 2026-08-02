const secretValue = /((?:token|secret|password|key)=)([^\s]+)/gi;

/** Redacts recognised secret-shaped values before process output is displayed or persisted. */
export function scrubProcessLog(value: string): string {
  return value.replace(secretValue, '$1[REDACTED]');
}
