import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowStatus } from '../../../orchestration/index.js';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const palette = read('../src/styles/palette.css');
const tokens = read('../src/styles/tokens.css');

function declarations(css: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
    found.set(match[1]!, match[2]!.trim());
  return found;
}

/** Resolves `var(--x)` against the palette so semantic tokens yield literal colours. */
function resolve(name: string): string {
  const value = declarations(tokens).get(name);
  if (value === undefined) throw new Error(`missing semantic token ${name}`);
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (reference === null) return value;
  const raw = declarations(palette).get(reference[1]!);
  if (raw === undefined) throw new Error(`semantic token ${name} references missing palette entry`);
  return raw;
}

function toLinear(part: number): number {
  const channel = part / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const digits = hex.trim().replace('#', '');
  const full =
    digits.length === 3 ? [...digits].map((character) => character + character).join('') : digits;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return (
    0.2126 * toLinear(Number.parseInt(full.slice(0, 2), 16)) +
    0.7152 * toLinear(Number.parseInt(full.slice(2, 4), 16)) +
    0.0722 * toLinear(Number.parseInt(full.slice(4, 6), 16))
  );
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

const conditions = [
  'ready',
  'scheduled',
  WorkflowStatus.Active,
  'needs-input',
  'error',
  'finished',
] as const;

describe('Wake design tokens', () => {
  it('assigns every semantic token from the palette layer, not from a literal', () => {
    for (const [name, value] of declarations(tokens))
      if (/#[0-9a-fA-F]{3,6}/.test(value))
        throw new Error(`semantic token ${name} hardcodes ${value}; assign it from palette.css`);
    expect(declarations(tokens).size).toBeGreaterThan(0);
  });

  it('defines the full condition vocabulary', () => {
    for (const condition of conditions) {
      expect(resolve(`--cond-${condition}-fg`)).toMatch(/^#/);
      expect(resolve(`--cond-${condition}-bg`)).toMatch(/^#/);
    }
  });

  it('meets WCAG AA for every condition pair', () => {
    for (const condition of conditions)
      expect(
        contrast(resolve(`--cond-${condition}-fg`), resolve(`--cond-${condition}-bg`)),
      ).toBeGreaterThanOrEqual(4.5);
  });

  it('meets WCAG AA for body and muted text on every surface', () => {
    for (const surface of ['--surface', '--surface-panel', '--surface-card', '--surface-inset'])
      for (const text of ['--ink', '--ink-muted'])
        expect(contrast(resolve(text), resolve(surface))).toBeGreaterThanOrEqual(4.5);
  });

  it('meets WCAG AA for navigation and link colours on their own bands', () => {
    expect(contrast(resolve('--ink-inverse'), resolve('--brand'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve('--nav-ink-idle'), resolve('--brand-darker'))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(resolve('--accent-light'), resolve('--brand-darker'))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(resolve('--accent'), resolve('--surface-card'))).toBeGreaterThanOrEqual(4.5);
  });
});
