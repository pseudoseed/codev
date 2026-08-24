import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusStamp } from '../src/components/StatusStamp.js';

describe('StatusStamp (scenario 6)', () => {
  afterEach(() => cleanup());
  it('renders GATE in rust and not RUN', () => {
    const { container } = render(<StatusStamp status="gate-waiting" />);
    expect(screen.getByText('GATE')).toBeTruthy();
    expect(container.querySelector('.stamp-gate')).toBeTruthy();
    expect(container.querySelector('.stamp-run')).toBeNull();
  });

  it('renders STALLED in ochre', () => {
    const { container } = render(<StatusStamp status="stalled" />);
    expect(screen.getByText('STALLED')).toBeTruthy();
    expect(container.querySelector('.stamp-stalled')).toBeTruthy();
  });

  it('renders an unknown status as the raw string, not RUN', () => {
    const { container } = render(<StatusStamp status="reticulating" />);
    expect(screen.getByText('reticulating')).toBeTruthy();
    expect(container.querySelector('.stamp-run')).toBeNull();
    expect(container.querySelector('.stamp-gate')).toBeNull();
    expect(container.querySelector('.stamp-stalled')).toBeNull();
    expect(container.querySelector('.stamp-unknown')).toBeTruthy();
  });
});
