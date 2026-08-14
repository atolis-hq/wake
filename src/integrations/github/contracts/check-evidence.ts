const diagnosticKeys = [
  'name',
  'status',
  'conclusion',
  'started_at',
  'completed_at',
  'details_url',
  'html_url',
  'context',
  'state',
  'target_url',
] as const;

const maxEvidenceEntries = 20;
const maxEvidenceBytes = 12_000;

export function boundedDiagnosticEvidence(
  evidence: readonly unknown[],
): readonly Readonly<Record<string, string | null>>[] {
  const bounded: Readonly<Record<string, string | null>>[] = [];
  let bytes = 0;
  for (const value of evidence) {
    if (bounded.length === maxEvidenceEntries) break;
    if (!isRecord(value)) continue;
    const diagnostic = diagnosticEvidence(value);
    const entryBytes = Buffer.byteLength(JSON.stringify(diagnostic), 'utf8');
    if (bytes + entryBytes > maxEvidenceBytes) break;
    bounded.push(diagnostic);
    bytes += entryBytes;
  }
  return bounded;
}

function diagnosticEvidence(
  entry: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | null>> {
  return Object.fromEntries(
    diagnosticKeys.flatMap((key) =>
      typeof entry[key] === 'string' || entry[key] === null ? [[key, entry[key]]] : [],
    ),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
