import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('../src/features/features.module.css', import.meta.url)),
  'utf8',
);
const mobileStart = css.indexOf('@media (max-width: 42rem)');
const desktop = css.slice(0, mobileStart);
const mobile = css.slice(mobileStart);

describe('resource card responsive styles', () => {
  it('keeps the desktop title treatment single-line and truncated', () => {
    expect(desktop).toMatch(
      /\.resourceCardTitle\s*{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
  });

  it('contains mobile card flex items and wraps long title or locator text', () => {
    expect(mobile).toMatch(/\.resourceList > li,[\s\S]*?\.resourceCardTop\s*{\s*min-width:\s*0;/);
    expect(mobile).toMatch(
      /\.resourceCardTitle\s*{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    );
  });

  it('keeps the external-link affordance visible on touch layouts', () => {
    expect(mobile).toMatch(/\.resourceCardExt\s*{\s*opacity:\s*1;/);
  });
});
