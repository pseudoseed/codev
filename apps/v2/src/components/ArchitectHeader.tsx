import type { ClientNode } from '../lib/validate.js';
import { BuilderRow } from './BuilderRow.js';
import { Glyph } from './Glyph.js';
import { StatusStamp } from './StatusStamp.js';

type Props = { node: ClientNode; builders?: ClientNode[] };

export function ArchitectHeader({ node, builders = [] }: Props) {
  const cls = ['arch-block', node.status === 'offline' ? 'dim-sub' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} data-kind="architect" data-id={node.id}>
      <div className="arch-row">
        <Glyph kind="architect" />
        <span className="stamp">
          <span className="kind-prefix">architect/</span>
          {node.name}
          {node.flags.heldMail ? <span className="held-mail">mail</span> : null}
        </span>
        <StatusStamp status={node.status} as="dot" />
      </div>
      {builders.length > 0 ? (
        <div className="stake-list">
          {builders.map((b) => (
            <BuilderRow key={b.id} node={b} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
