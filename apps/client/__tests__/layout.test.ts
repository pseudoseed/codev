/**
 * The arithmetic behind criteria 4, 4b and 5, checked where it is cheap.
 *
 * These assertions do NOT replace the Playwright specs. A pure function can say
 * three columns at 1440; only a rendered page can say the panes that resulted
 * are 340px wide and their text is 13px. Both exist because the plan says the
 * criteria are arithmetic AND says they must be measured from the DOM — this
 * file is the first half, and it is the half that names WHY a number is what it
 * is when the second half goes red.
 */
import { describe, expect, it } from 'vitest';
import {
  ARCHITECT_TILE_MIN_WIDTH,
  architectPlacement,
  columnsFor,
  columnsThatFit,
  layoutModeFor,
  MIN_PANE_W,
  paneWidthAt,
} from '../src/responsive/layout.js';

describe('layoutModeFor', () => {
  it('pages below 700 and grids at and above it', () => {
    expect(layoutModeFor(390)).toBe('paged');
    expect(layoutModeFor(699)).toBe('paged');
    expect(layoutModeFor(700)).toBe('standard');
    expect(layoutModeFor(1440)).toBe('standard');
  });

  it('only reaches the wide layout at 1920', () => {
    expect(layoutModeFor(ARCHITECT_TILE_MIN_WIDTH - 1)).toBe('standard');
    expect(layoutModeFor(ARCHITECT_TILE_MIN_WIDTH)).toBe('wide');
  });
});

describe('columnsFor', () => {
  it('criterion 4: six builders tile 3x2 at 1440', () => {
    expect(columnsFor(6, 1440)).toBe(3);
    expect(Math.ceil(6 / columnsFor(6, 1440))).toBe(2);
  });

  /*
   * THE BUG THIS PINS. `repeat(auto-fill, minmax(340px, 1fr))` is the obvious
   * CSS and it maximises columns: four 340px columns fit in 1440 less padding,
   * so six builders would tile 4 + 2. The criterion names 3x2, and
   * `columnsThatFit` is asserted separately to show the cap is not what produced
   * the 3 — the rule did.
   */
  it('does not simply maximise columns', () => {
    expect(columnsThatFit(1440 - 36)).toBe(4);
    expect(columnsFor(6, 1440)).toBe(3);
  });

  /*
   * Fewest ROWS, not most square. A near-square rule gives seven panes at 1920
   * a 3x3 with a last row that is one tile and two empty cells; this gives 4x2.
   */
  it('fills the width rather than leaving two-thirds of a row empty', () => {
    expect(columnsFor(7, 1920)).toBe(4);
    expect(Math.ceil(7 / columnsFor(7, 1920))).toBe(2);
  });

  it('adds a row only when the columns stop fitting', () => {
    expect(columnsFor(3, 1440)).toBe(3);
    expect(columnsFor(4, 1440)).toBe(4);
    expect(columnsFor(5, 1440)).toBe(3);
    expect(columnsFor(12, 1440)).toBe(4);
  });

  it('never puts a pane under the 340px floor', () => {
    for (const width of [700, 900, 1100, 1280, 1440, 1600, 1920, 2560]) {
      for (const count of [1, 2, 3, 4, 5, 6, 7, 9, 12]) {
        expect(paneWidthAt(count, width)).toBeGreaterThanOrEqual(MIN_PANE_W);
      }
    }
  });

  it('collapses to one column in the paged layout, whatever the count', () => {
    expect(columnsFor(6, 390)).toBe(1);
    expect(columnsFor(1, 390)).toBe(1);
  });

  it('never asks for more columns than there are panes', () => {
    expect(columnsFor(2, 2560)).toBe(2);
    expect(columnsFor(1, 2560)).toBe(1);
  });
});

describe('architectPlacement', () => {
  it('criterion 4b: a strip below 1920, a tile at 1920 and wider', () => {
    expect(architectPlacement(1440)).toBe('strip');
    expect(architectPlacement(1919)).toBe('strip');
    expect(architectPlacement(1920)).toBe('tile');
    expect(architectPlacement(2560)).toBe('tile');
  });

  it('gives the narrow layout a strip too, since it has no grid to sit beside', () => {
    expect(architectPlacement(390)).toBe('strip');
  });
});
