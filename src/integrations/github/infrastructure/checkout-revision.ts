/** Read actions/checkout's full Git log result, never the mutable PR merge ref. */
export function checkoutRevision(log: string): string | undefined {
  let checkout = false;
  let expectingSha = false;
  const revisions: string[] = [];
  for (const line of log.split('\n')) {
    const message = line.replace(/^\S+\s/, '').trim();
    if (message.startsWith('##[group]Run ')) {
      checkout = message.startsWith('##[group]Run actions/checkout@');
      expectingSha = false;
    }
    if (!checkout) continue;
    if (expectingSha) {
      if (/^[a-f0-9]{40}$/.test(message)) revisions.push(message);
      expectingSha = false;
    }
    if (/^\[command\].*\/git log -1 --format=%H$/.test(message)) expectingSha = true;
  }
  return revisions.length === 1 ? revisions[0] : undefined;
}
