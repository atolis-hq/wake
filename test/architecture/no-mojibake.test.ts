import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const forbidden = [
  String.fromCodePoint(0x00e2),
  String.fromCodePoint(0x00c3),
  String.fromCodePoint(0xfffd),
];
const excluded = /^(?:node_modules|dist|coverage|\.git)\//;

describe('committed source encoding', () => {
  it('contains no mojibake signatures', { timeout: 30_000 }, () => {
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const offenders = files.filter((file) => {
      if (excluded.test(file)) return false;
      if (!existsSync(file)) return false;
      const content = readFileSync(file);
      if (content.includes(0)) return false;
      const text = content.toString('utf8');
      return forbidden.some((value) => text.includes(value));
    });
    expect(offenders).toEqual([]);
  }, 30_000);
});
