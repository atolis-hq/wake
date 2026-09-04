import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('Eventing adapter contract ownership', () => {
  it('runs one shared behavioral contract against memory and filesystem factories', async () => {
    const [shared, memory, filesystem] = await Promise.all([
      read('test/contracts/eventing-adapter-contract.ts'),
      read('packages/eventing/test/memory/eventing-adapter-contract.test.ts'),
      read('packages/eventing-filesystem/test/eventing-adapter-contract.test.ts'),
    ]);

    expect(shared).toContain('export function eventingAdapterContract');
    expect(memory).toContain("eventingAdapterContract('memory'");
    expect(filesystem).toContain("eventingAdapterContract('filesystem'");
    expect(memory).toContain('test/contracts/eventing-adapter-contract.js');
    expect(filesystem).toContain('test/contracts/eventing-adapter-contract.js');
    expect(filesystem).toContain('flatRecordCompatibility');
  });
});
