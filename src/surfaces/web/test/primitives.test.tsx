import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Chip } from '../src/components/chip.js';
import { Tile } from '../src/components/tile.js';

describe('dense presentation primitives', () => {
  afterEach(cleanup);

  it('renders chips for arbitrary open values without interpreting them', () => {
    render(
      <>
        <Chip>dark-factory</Chip>
        <Chip variant="outline">phase:6</Chip>
      </>,
    );
    expect(screen.getByText('dark-factory')).toBeTruthy();
    expect(screen.getByText('phase:6')).toBeTruthy();
  });

  it('renders a tile as a labelled statistic', () => {
    render(<Tile label="Runs" value="42" />);
    const tile = screen.getByRole('group', { name: 'Runs' });
    expect(tile.textContent).toContain('42');
  });
});
