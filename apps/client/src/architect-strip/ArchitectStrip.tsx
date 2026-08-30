import type { PaneItem } from '../grid/collect.js';
import { StatusStamp } from '../tree/StatusStamp.js';

/**
 * Criterion 4b: the architect is not a seventh tile below 1920.
 *
 * ## Why a strip rather than a tile
 *
 * Six builders and an architect is seven panes, and seven near-square tiles at
 * 1440x900 puts every one of them under the 340x240 floor — the criterion the
 * grid exists to hold. The architect is also the one row an operator reads
 * differently: they watch builders for work and glance at the architect for
 * whether it is still there. So it gets a full-width persistent strip carrying
 * the two things that glance wants — status, and the last thing it was told —
 * and the whole pane on demand.
 *
 * Expansion REPLACES the grid rather than overlaying it. An overlay at this
 * width covers the builders it was opened to compare against.
 */
export function ArchitectStrip({
  architects,
  expandedKey,
  onExpand,
}: {
  architects: readonly PaneItem[];
  expandedKey: string | null;
  onExpand: (key: string | null) => void;
}) {
  if (architects.length === 0) {
    return (
      <div className="architect-strip is-empty">
        <span className="stamp strip-label">architect</span>
        <span className="strip-detail">No architect is recorded on any connected machine.</span>
      </div>
    );
  }
  return (
    <div className="architect-strip" data-strip="architects">
      {architects.map((item) => {
        const last = item.row.messages?.[0];
        const expanded = expandedKey === item.row.key;
        return (
          <div className="strip-row" key={item.row.key} data-architect={item.row.name}>
            <span className="stamp strip-label">
              <span className="kind-prefix">architect/</span>{item.row.name}
            </span>
            <StatusStamp status={item.row.status} />
            {/*
              * ONE MESSAGE, AND WHICH ABSENCE IT IS. The strip has room for the
              * last message only, but "nothing was said" and "the log would not
              * open" must not share a blank space here any more than they do in
              * a pane.
              */}
            <span className="strip-detail">
              {item.messageLog === 'unreadable'
                ? 'message log unreadable on this machine'
                : item.messageLog === 'not-provided'
                  ? 'this server does not report messages'
                  : last
                    ? `${last.from}: ${last.body}${last.truncated ? ' — CUT' : ''}`
                    : 'no messages'}
            </span>
            <button
              type="button"
              className="strip-expand"
              aria-expanded={expanded}
              onClick={() => onExpand(expanded ? null : item.row.key)}
            >
              {expanded ? 'Back to grid' : 'Expand'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
