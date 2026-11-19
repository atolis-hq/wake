import type { DatabaseSync } from 'node:sqlite';

interface Entry {
  readonly identity: string;
  readonly database: DatabaseSync;
}

const maximumConnections = 4;
const connections = new Map<string, Entry>();

/** Connections retain no read transaction between synchronous snapshot captures. */
export function borrowReadonlyIndex(
  path: string,
  identity: string,
  create: () => DatabaseSync,
): { database: DatabaseSync; invalidate(): void; release(): void } {
  // Windows must release file handles before callers remove fixture directories.
  if (process.platform === 'win32') {
    const database = create();
    const close = () => {
      if (database.isOpen) database.close();
    };
    return { database, invalidate: close, release: close };
  }
  let entry = connections.get(path);
  if (entry?.identity !== identity) {
    invalidateReadonlyIndex(path);
    entry = { identity, database: create() };
  }
  connections.delete(path);
  connections.set(path, entry);
  while (connections.size > maximumConnections)
    invalidateReadonlyIndex(connections.keys().next().value!);
  const database = entry.database;
  return {
    database,
    release() {},
    invalidate() {
      if (connections.get(path)?.database === database) invalidateReadonlyIndex(path);
    },
  };
}

export function invalidateReadonlyIndex(path: string): void {
  const entry = connections.get(path);
  connections.delete(path);
  if (entry?.database.isOpen) entry.database.close();
}
