import type { ClientCounts } from '../lib/validate.js';
import { Glyph } from './Glyph.js';

type Props = { counts: ClientCounts | null };

/*
 * The mockup's top bar carries a machine count and the find-node and
 * add-machine buttons. /v2/events is a single-machine stream and those two
 * controls are later units, so the register line states only what the wire
 * carries: workspaces and builders on this machine.
 */
export function SiteHeader({ counts }: Props) {
  return (
    <header className="lot-header">
      <span className="mark">
        <span className="mark-badge">
          <Glyph kind="architect" />
        </span>
        <span className="mark-name">Porch</span>
      </span>
      <span className="mark-rule" aria-hidden="true" />
      <span className="stamp site-register" data-testid="site-register">
        Site register
        {counts ? ` · ${counts.workspaces} workspaces · ${counts.builders.total} builders` : null}
      </span>
    </header>
  );
}
