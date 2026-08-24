import { TRACE_LEN } from '../lib/validate.js';

type Props = { values?: number[] };

export function Sparkline({ values }: Props) {
  const bars = values && values.length === TRACE_LEN ? values : Array.from({ length: TRACE_LEN }, () => 0);
  const peak = Math.max(1, ...bars);
  return (
    <div className="spark" data-testid="spark">
      {bars.map((v, i) => (
        <i key={i} style={{ height: `${2 + (v / peak) * 18}px` }} />
      ))}
    </div>
  );
}
