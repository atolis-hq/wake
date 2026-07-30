export function failureFrom(error: unknown): { kind: string; message: string } {
  return error instanceof Error
    ? { kind: error.name, message: error.message }
    : { kind: 'Error', message: String(error) };
}
