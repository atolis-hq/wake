const secret = /((?:token|secret|password|key)=)([^\s]+)/gi;

export function scrubProcessLog(value: string): string {
  return value.replace(secret, '$1[REDACTED]');
}
