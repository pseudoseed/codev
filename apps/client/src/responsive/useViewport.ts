import { useEffect, useState } from 'react';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The live viewport, because every layout decision here is a function of it.
 *
 * `resize` rather than a media query per breakpoint: the rules in `layout.ts`
 * are arithmetic over the actual width, not three fixed bands, and a set of
 * media queries would have to restate that arithmetic in a second language that
 * could then disagree with the first.
 */
export function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return viewport;
}
