import type { ClientNode } from '../lib/validate.js';
import { Sparkline } from './Sparkline.js';
import { StatusStamp } from './StatusStamp.js';

type Props = { node: ClientNode };

export function BuilderRow({ node }: Props) {
  const gate = node.status === 'gate-waiting';
  const offline = node.status === 'offline';
  const cls = ['stake', gate ? 'needs-attn' : '', offline ? 'dim-sub' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} data-kind="builder" data-id={node.id}>
      <div className="stake-top">
        <span className="stamp stake-name">
          {node.name}
          {node.flags.heldMail ? <span className="held-mail">mail</span> : null}
        </span>
        <StatusStamp status={node.status} />
      </div>
      <Sparkline values={node.buckets} />
    </div>
  );
}
