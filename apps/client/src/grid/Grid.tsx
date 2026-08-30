import { useEffect, useState } from 'react';
import { ArchitectStrip } from '../architect-strip/ArchitectStrip.js';
import type { GateApprovalHandle } from '../gate/GatePanel.js';
import { BuilderPane } from '../pane/BuilderPane.js';
import {
  architectPlacement,
  columnsFor,
  GRID_GAP,
  layoutModeFor,
  MIN_PANE_H,
  MIN_PANE_W,
} from '../responsive/layout.js';
import { useViewport } from '../responsive/useViewport.js';
import type { MachineNode } from '../tree/build.js';
import { collectPanes, type PaneItem } from './collect.js';

function Pane({ item, nowMs, multiMachine }: {
  item: PaneItem;
  nowMs: number;
  multiMachine: boolean;
}) {
  return (
    <BuilderPane
      row={item.row}
      approval={item.approval}
      messageLog={item.messageLog}
      nowMs={nowMs}
      showMachine={multiMachine}
      stale={item.stale}
    />
  );
}

/**
 * The tiled grid — criteria 4, 4b and 5.
 *
 * Three layouts and one component, because they are the same panes under
 * different arithmetic rather than three different screens. `layout.ts` owns
 * every number; this file owns only where things go.
 *
 * ## The paged layout does not shrink the grid
 *
 * At 390px the criterion is one pane per screen with NO horizontal scroll, which
 * rules out both a scaled-down grid and a horizontally-scrolling strip of tiles.
 * So the narrow layout renders exactly one pane and moves between them, and the
 * grid's minimum column width is applied ONLY in the grid layouts — a 340px
 * floor on a 390px phone is what puts a scrollbar under the page.
 */
export function Grid({ machines, nowMs, approvalFor }: {
  machines: readonly MachineNode[];
  nowMs: number;
  approvalFor?: (machineKey: string) => GateApprovalHandle | null;
}) {
  const viewport = useViewport();
  const mode = layoutModeFor(viewport.width);
  const { builders, architects, multiMachine, sessionNotes } = collectPanes(machines, approvalFor);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // At 1920 the architect becomes a tile, so an expansion opened in the strip
  // has nothing left to expand from. Clearing it here rather than ignoring it
  // avoids a state that reappears on the way back down through the breakpoint.
  const placement = architectPlacement(viewport.width);
  useEffect(() => {
    if (placement === 'tile') setExpandedKey(null);
  }, [placement]);

  const tiles: readonly PaneItem[] = placement === 'tile' ? [...builders, ...architects] : builders;
  /*
   * THE PAGED SEQUENCE IS NOT THE TILE LIST. Below 700px there is no strip to
   * put the architect in — a strip on a phone is a row nobody can open — so the
   * architect is a page like any other. Deriving the pager's bounds from `tiles`
   * instead capped it one short of the end and left the last pane unreachable.
   */
  const paged: readonly PaneItem[] = [...builders, ...architects];
  const pageCount = Math.max(1, paged.length);
  const current = Math.min(page, pageCount - 1);

  // A pane that leaves the list must not strand the pager past the end.
  useEffect(() => {
    if (page > pageCount - 1) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  if (tiles.length === 0 && architects.length === 0) {
    return (
      <p className="empty-note">
        No machine has reported an architect, a builder or a thread. The client shows what it
        is connected to and nothing else.
      </p>
    );
  }

  const expanded = expandedKey
    ? architects.find((item) => item.row.key === expandedKey) ?? null
    : null;

  if (mode === 'paged') {
    const item = paged[current];
    return (
      <div className="paged" data-layout="paged">
        {sessionNotes.map((note) => (
          <p className="session-note" key={note}>{note}</p>
        ))}
        <div className="pager" role="group" aria-label="Move between panes">
          <button
            type="button"
            className="pager-step"
            data-step="previous"
            disabled={current === 0}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            Previous
          </button>
          <span className="stamp pager-position" data-position={`${current + 1}/${paged.length}`}>
            {current + 1} of {paged.length}
          </span>
          <button
            type="button"
            className="pager-step"
            data-step="next"
            disabled={current >= paged.length - 1}
            onClick={() => setPage((value) => Math.min(paged.length - 1, value + 1))}
          >
            Next
          </button>
        </div>
        {item ? <Pane item={item} nowMs={nowMs} multiMachine={multiMachine} /> : null}
      </div>
    );
  }

  if (expanded) {
    return (
      <div className="expanded-architect" data-layout="expanded">
        <button type="button" className="strip-expand" onClick={() => setExpandedKey(null)}>
          Back to grid
        </button>
        <Pane item={expanded} nowMs={nowMs} multiMachine={multiMachine} />
      </div>
    );
  }

  const columns = columnsFor(tiles.length, viewport.width);
  return (
    <div className="tiling" data-layout={mode}>
      {sessionNotes.map((note) => (
        <p className="session-note" key={note}>{note}</p>
      ))}
      <div
        className="tile-grid"
        data-columns={columns}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(${MIN_PANE_W}px, 1fr))`,
          gap: `${GRID_GAP}px`,
          gridAutoRows: `minmax(${MIN_PANE_H}px, auto)`,
        }}
      >
        {tiles.map((item) => (
          <Pane item={item} nowMs={nowMs} multiMachine={multiMachine} key={item.row.key} />
        ))}
      </div>
      {placement === 'strip' ? (
        <ArchitectStrip
          architects={architects}
          expandedKey={expandedKey}
          onExpand={setExpandedKey}
        />
      ) : null}
    </div>
  );
}
