/*
 * The mockup's node-kind icons. It reaches for Font Awesome; a CDN font is
 * not a build target here (spec 83, D3), so the two glyphs that carry
 * meaning are inlined as paths and take their colour from the text.
 */
type Props = { kind: 'workspace' | 'architect' };

export function Glyph({ kind }: Props) {
  if (kind === 'workspace') {
    return (
      <svg className="glyph" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.1">
          <rect x="0.8" y="1" width="4.4" height="3" />
          <rect x="6.6" y="7.4" width="4.6" height="2.8" />
          <path d="M2.6 4.2v4.6h4" />
        </g>
      </svg>
    );
  }
  return (
    <svg className="glyph" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.1">
        <circle cx="6" cy="2" r="1.2" />
        <path d="M5.3 3.1 2.4 10.6M6.7 3.1 9.6 10.6" />
      </g>
    </svg>
  );
}
