import type { ClientNode } from '../lib/validate.js';
import { StatusStamp } from './StatusStamp.js';

type Props = { node: ClientNode };

export function ArchitectHeader({ node }: Props) {
  const cls = ['arch-row', node.status === 'offline' ? 'dim-sub' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} data-kind="architect" data-id={node.id}>
      <span className="stamp">
        {node.name}
        {node.flags.heldMail ? <span className="held-mail">mail</span> : null}
      </span>
      <StatusStamp status={node.status} />
    </div>
  );
}
