/** App icon artwork for next/og ImageResponse (home screen, manifest, favicon). */
export function AppIconArt({ px, maskable = false, rounded = true, light = false }: {
  px: number;
  maskable?: boolean;
  rounded?: boolean;
  light?: boolean;
}) {
  const s = maskable ? 0.72 : 1; // shrink the mark into the maskable safe zone
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: light ? '#f5f3ff' : 'linear-gradient(145deg, #262626 0%, #0a0a0a 100%)',
        borderRadius: rounded && !maskable ? px * 0.225 : 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: px * 0.035 * s, marginTop: px * 0.02 }}>
        <svg width={px * 0.3 * s} height={px * 0.3 * s} viewBox="0 0 30 30">
          <path d="M5 5 L20 15 L5 25" fill="none" stroke={light ? '#332663' : '#f5f5f5'} strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div style={{ width: px * 0.24 * s, height: px * 0.065 * s, background: '#d97757', borderRadius: px * 0.02 * s, marginBottom: px * 0.035 * s }} />
      </div>
    </div>
  );
}
