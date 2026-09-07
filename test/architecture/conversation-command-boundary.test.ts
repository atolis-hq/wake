import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

it('keeps external-message command dispatch outside the GitHub adapter', async () => {
  const [inbound, reactor] = await Promise.all([
    read('src/integrations/github/application/inbound-translator.ts'),
    read('src/orchestration/application/conversation-command-reactor.ts'),
  ]);

  expect(inbound).not.toContain('applyConversationCommand(');
  expect(reactor).toContain("consumer: 'reactor:orchestration.conversation-command'");
  expect(reactor).toContain('ConversationEventType.EntryRecorded');
});
