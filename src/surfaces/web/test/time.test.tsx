import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LocalTime, formatLocalTime } from '../src/components/local-time.js';

describe('operator time presentation', () => {
  it('localizes display while retaining exact UTC access across a DST boundary', () => {
    const instant = '2026-03-29T00:30:00.000Z';
    expect(formatLocalTime(instant, 'en-GB', 'Europe/London')).toContain('00:30');
    render(<LocalTime value={instant} locale="en-GB" timeZone="Europe/London" />);
    expect(screen.getByTitle(instant).getAttribute('datetime')).toBe(instant);
    expect(screen.getByTitle(instant).getAttribute('aria-label')).toContain(instant);
  });
});
