import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface ContractDiagnostic {
  readonly message: string;
}

type CheckContractVocabulary = (
  root: string,
  options?: { readonly rules?: readonly string[] },
) => Promise<readonly ContractDiagnostic[]>;

const checkerModulePath = '../../scripts/lib/contract-vocabulary.mjs';
const checker = (await import(checkerModulePath)) as {
  readonly checkContractVocabulary: CheckContractVocabulary;
};
const { checkContractVocabulary } = checker;
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-provider-locality-'));
  fixtureRoots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, source]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }),
  );
  return root;
}

function messages(diagnostics: readonly ContractDiagnostic[]): string {
  return diagnostics.map(({ message }) => message).join('\n');
}

async function check(files: Readonly<Record<string, string>>) {
  const root = await fixture(files);
  return checkContractVocabulary(root, { rules: ['provider-locality'] });
}

describe('provider-locality value scope', () => {
  it('rejects a provider name inside a WorkItem identity argument', async () => {
    const diagnostics = await check({
      'src/integrations/github/application/inbound-translator.ts': [
        "import { workItemId } from '../../../work/index.js';",
        'export function mint(counter: number) {',
        '  return workItemId(`work-github-${counter}`);',
        '}',
      ].join('\n'),
    });

    expect(diagnostics).toHaveLength(1);
    expect(messages(diagnostics)).toContain('[provider-locality]');
    expect(messages(diagnostics)).toMatch(
      /src\/integrations\/github\/application\/inbound-translator\.ts:3:\d+/,
    );
  });

  it('rejects a provider name inside a Resource stream id', async () => {
    const diagnostics = await check({
      'src/integrations/github/application/resource-translator.ts': [
        "import { resourceStream } from '../../../resources/index.js';",
        'export function mint() {',
        '  return resourceStream(`resource-github-42`);',
        '}',
      ].join('\n'),
    });

    expect(diagnostics).toHaveLength(1);
    expect(messages(diagnostics)).toContain('[provider-locality]');
    expect(messages(diagnostics)).toMatch(
      /src\/integrations\/github\/application\/resource-translator\.ts:3:\d+/,
    );
  });

  it('rejects a provider name inside a work.* or resource.* event type literal', async () => {
    const diagnostics = await check({
      'src/integrations/github/infrastructure/issue-source.ts': [
        'export function draft() {',
        '  return {',
        "    eventType: 'work.github-observed',",
        '  };',
        '}',
      ].join('\n'),
    });

    expect(diagnostics).toHaveLength(1);
    expect(messages(diagnostics)).toContain('[provider-locality]');
    expect(messages(diagnostics)).toMatch(
      /src\/integrations\/github\/infrastructure\/issue-source\.ts:3:\d+/,
    );
  });

  it('allows a provider name inside its own namespace when it does not reach a domain value', async () => {
    const diagnostics = await check({
      'src/integrations/github/infrastructure/client.ts':
        "export const baseUrl = 'https://api.github.com';",
    });

    expect(diagnostics).toEqual([]);
  });

  it('allows a provider name in an integration.* event type', async () => {
    const diagnostics = await check({
      'src/integrations/github/infrastructure/source.ts': [
        'export function draft() {',
        '  return {',
        "    eventType: 'integration.github-polled',",
        '  };',
        '}',
      ].join('\n'),
    });

    expect(diagnostics).toEqual([]);
  });
});

describe('provider-locality path scope', () => {
  it('permits a provider name in operational string and template literals outside its namespace', async () => {
    const diagnostics = await check({
      'src/integrations/github/index.ts': 'export const marker = true;',
      'src/bootstrap/sandbox-template.ts': [
        "export const prompt = 'Configure GitHub auth?';",
        'export const dockerfile = `curl https://cli.github.com/packages`;',
      ].join('\\n'),
    });

    expect(diagnostics).toEqual([]);
  });

  it('rejects a provider name in a file outside the provider namespace', async () => {
    const diagnostics = await check({
      'src/integrations/github/index.ts': 'export const marker = true;',
      'src/work/domain/leak.ts': 'export const usesGithubApi = true;',
    });

    expect(diagnostics).toHaveLength(1);
    expect(messages(diagnostics)).toContain('[provider-locality]');
    expect(messages(diagnostics)).toMatch(/src\/work\/domain\/leak\.ts:1:\d+/);
  });

  it('permits ExternalResourceKey.adapter and adapterId() values everywhere', async () => {
    const diagnostics = await check({
      'src/integrations/github/index.ts': 'export const marker = true;',
      'src/resources/domain/fixture.ts': [
        "import { adapterId } from '../../integrations/index.js';",
        "export const key = { adapter: 'github', id: adapterId('github') };",
      ].join('\n'),
    });

    expect(diagnostics).toEqual([]);
  });

  it('is exempt from path scope only for bootstrap/composition-root.ts', async () => {
    const diagnostics = await check({
      'src/integrations/github/index.ts': 'export const marker = true;',
      'src/bootstrap/composition-root.ts':
        "import { gitHubProviderDefinition } from '../integrations/github/index.js';",
    });

    expect(diagnostics).toEqual([]);
  });

  it('derives providers from the integrations directory automatically, covering a second provider without code changes', async () => {
    const diagnostics = await check({
      'src/integrations/contracts/marker.ts': 'export const marker = true;',
      'src/integrations/application/marker.ts': 'export const marker = true;',
      'src/integrations/delivery/marker.ts': 'export const marker = true;',
      'src/integrations/fake/marker.ts': 'export const marker = true;',
      'src/integrations/github/index.ts': 'export const marker = true;',
      'src/integrations/gitlab/index.ts': 'export const marker = true;',
      'src/work/domain/leak.ts': 'export const usesGitlabApi = true;',
    });

    expect(diagnostics).toHaveLength(1);
    expect(messages(diagnostics)).toContain('"gitlab"');
    expect(messages(diagnostics)).toMatch(/src\/work\/domain\/leak\.ts:1:\d+/);
  });
});
