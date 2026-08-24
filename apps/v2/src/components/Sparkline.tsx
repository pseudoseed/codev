import { TRACE_LEN } from '../lib/validate.js';

type Props = { values?: number[]; status?: string };

/* A bar drawn at its literal value is invisible when the value is zero, and an
   idle builder then reads as a broken one. Every bar gets IDLE_PX so a quiet
   trace is a flat baseline — the mockup's ".......", not nothing. */
export const IDLE_PX = 3;
const PEAK_PX = 19;

export function Sparkline({ values, status }: Props) {
  const bars = values && values.length === TRACE_LEN ? values : Array.from({ length: TRACE_LEN }, () => 0);
  const peak = Math.max(1, ...bars);
  return (
    <div className="spark" data-testid="spark" data-status={status ?? 'unknown'}>
      {bars.map((v, i) => (
        <i
          key={i}
          className={v > 0 ? 'live' : 'idle'}
          style={{ height: `${IDLE_PX + (v / peak) * PEAK_PX}px` }}
        />
      ))}
    </div>
  );
}
