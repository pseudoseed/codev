import type { ClientNode } from '../lib/validate.js';
import { BuilderRow } from './BuilderRow.js';
import { StatusStamp } from './StatusStamp.js';

type Props = { node: ClientNode; builders?: ClientNode[] };

export function ArchitectHeader({ node, builders = [] }: Props) {
  const cls = ['arch-block', node.status === 'offline' ? 'dim-sub' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} data-kind="architect" data-id={node.id}>
      <div className="arch-row">
        <span className="stamp">
          {node.name}
          {node.flags.heldMail ? <span className="held-mail">mail</span> : null}
        </span>
        <StatusStamp status={node.status} />
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
