import type { RowStatus } from '../status/derive.js';
import { statusWord } from '../status/derive.js';

const CLASS: Record<RowStatus['kind'], string> = {
  blocked: 'stamp-gate',
  turning: 'stamp-turning',
  working: 'stamp-working',
  settled: 'stamp-settled',
  stopped: 'stamp-stopped',
  error: 'stamp-error',
  unknown: 'stamp-unknown',
};

/**
 * The word, never a bare dot.
 *
 * A status shown only as a coloured dot is how #112 shipped idle sparklines as
 * invisible marks. The colour is the second signal here, not the first.
 */
export function StatusStamp({ status }: { status: RowStatus }) {
  return (
    <span
      className={`stamp status-stamp ${CLASS[status.kind]}`}
      data-status={status.kind}
      title={status.why ?? statusWord(status)}
    >
      {statusWord(status)}
    </span>
  );
}
