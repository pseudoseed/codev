import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sparkline } from '../src/components/Sparkline.js';

describe('Sparkline', () => {
  afterEach(() => cleanup());
  it('renders 20 bars', () => {
    const { container } = render(<Sparkline values={Array.from({ length: 20 }, (_, i) => i)} />);
    expect(container.querySelectorAll('.spark i')).toHaveLength(20);
  });

  it('renders a flat trace when values are missing', () => {
    const { container } = render(<Sparkline />);
    expect(container.querySelectorAll('.spark i')).toHaveLength(20);
  });
});
