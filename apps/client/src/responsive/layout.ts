/**
 * The arithmetic behind criteria 4, 4b and 5.
 *
 * These are the numbers a component test cannot check — they are measured from a
 * rendered page under Playwright — so the rules that produce them live here as
 * pure functions with their own unit tests, and the components do nothing but
 * apply what these return.
 *
 * ## Why the column count is computed rather than left to `auto-fill`
 *
 * `repeat(auto-fill, minmax(340px, 1fr))` looks like the obvious spelling and
 * gives the WRONG answer at the one viewport the criterion names: 1440 less the
 * page's padding leaves 1404, and four 340px columns fit in that. Six builders
 * would tile 4 + 2, not the 3x2 the spec requires. `auto-fill` maximises columns;
 * the criterion wants a near-square grid that never goes below the floor. Those
 * are different rules and only one of them is expressible in CSS.
 */

/** Criterion 4's floor. Below this a pane stops being readable at a glance. */
export const MIN_PANE_W = 340;
export const MIN_PANE_H = 240;
/** Criterion 4's body-text floor. Applied as a CSS custom property, asserted from the DOM. */
export const MIN_BODY_PX = 13;

export const GRID_GAP = 12;
export const PAGE_PADDING = 18;

/**
 * Below this the grid PAGES rather than shrinks (criterion 5).
 *
 * 700 rather than 680 (= 2 x 340 + gap): a two-column grid whose panes are
 * exactly at the floor with no page padding left is the arithmetic minimum, not
 * a usable layout. One column below 700, two at 700 and above.
 */
export const PAGING_MAX_WIDTH = 699;

/** Criterion 4b: the width at which the architect is offered a tile of its own. */
export const ARCHITECT_TILE_MIN_WIDTH = 1920;

export type LayoutMode = 'paged' | 'standard' | 'wide';

export function layoutModeFor(viewportWidth: number): LayoutMode {
  if (viewportWidth <= PAGING_MAX_WIDTH) return 'paged';
  return viewportWidth >= ARCHITECT_TILE_MIN_WIDTH ? 'wide' : 'standard';
}

/**
 * Criterion 4b in one predicate: the architect gets a strip below the grid, and
 * only at 1920 or wider is a seventh equal tile on offer.
 */
export function architectPlacement(viewportWidth: number): 'tile' | 'strip' {
  return layoutModeFor(viewportWidth) === 'wide' ? 'tile' : 'strip';
}

/** The width the grid itself gets, once the page's padding is taken out. */
export function contentWidth(viewportWidth: number): number {
  return Math.max(0, viewportWidth - PAGE_PADDING * 2);
}

/**
 * How many columns fit at this width without any pane falling under the floor.
 *
 * N columns need N panes plus N-1 gaps, which is why the gap is added to both
 * sides of the division rather than only the numerator.
 */
export function columnsThatFit(available: number, gap = GRID_GAP): number {
  return Math.max(1, Math.floor((available + gap) / (MIN_PANE_W + gap)));
}

/**
 * The column count for `count` panes at `viewportWidth`.
 *
 * THE RULE IS "AS FEW ROWS AS FIT", not "as square as possible". Both give 3 for
 * six panes at 1440 — the 3x2 the criterion names — but they diverge as soon as
 * the grid is not a neat rectangle. A near-square rule puts seven panes at 1920
 * into 3x3, which is three columns of a five-column-wide screen and a last row
 * holding one tile beside two tiles' worth of nothing. Fewest-rows gives 4x2:
 * every pane larger, one short row instead of two-thirds of one empty.
 *
 * So: try one row, then two, and stop at the first row count whose columns fit
 * without any pane falling under the 340px floor.
 */
export function columnsFor(count: number, viewportWidth: number): number {
  if (count <= 0) return 1;
  if (layoutModeFor(viewportWidth) === 'paged') return 1;
  const fits = columnsThatFit(contentWidth(viewportWidth));
  for (let rows = 1; rows <= count; rows += 1) {
    const columns = Math.ceil(count / rows);
    if (columns <= fits) return columns;
  }
  return 1;
}

/**
 * The width one pane will actually get, for the tests that assert the floor
 * holds rather than trusting that it does.
 */
export function paneWidthAt(count: number, viewportWidth: number): number {
  const columns = columnsFor(count, viewportWidth);
  const available = contentWidth(viewportWidth);
  return (available - GRID_GAP * (columns - 1)) / columns;
}
