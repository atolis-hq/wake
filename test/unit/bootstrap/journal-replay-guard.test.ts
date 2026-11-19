import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

// These types fold the whole journal on first use and are incremental after
// that, so each construction is a journal replay. A per-call construction
// replays the journal on every call, which is quadratic on a long-lived home
// (see #1058). Adding a site here is a deliberate decision: construct once at
// composition and share the instance.
const FOLDING = /new (OrchestrationRepository|RunRepository|WorkIndex|ResourceRepository)\(/g;
const allowed: Readonly<Record<string, number>> = {
  'src/bootstrap/artifact-mcp.ts': 1, // single run stream load per MCP call, not a fold
  'src/bootstrap/composition-root.ts': 3,
  'src/bootstrap/delegation-authority.ts': 1,
  'src/bootstrap/integration-runtime.ts': 3,
  'src/execution/application/execution-service.ts': 1,
  'src/execution/application/recovery-service.ts': 1,
  'src/orchestration/application/orchestration-service.ts': 1,
  'src/resources/application/resource-service.ts': 1,
  'src/work/application/work-service.ts': 1,
};

it('constructs journal-folding repositories only at their reviewed sites', () => {
  const found: Record<string, number> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) {
        const count = readFileSync(path, 'utf8').match(FOLDING)?.length ?? 0;
        if (count > 0) found[relative(process.cwd(), path)] = count;
      }
    }
  };
  walk(join(process.cwd(), 'src'));

  expect(found).toEqual(allowed);
});
