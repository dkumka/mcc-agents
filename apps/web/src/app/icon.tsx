import { ImageResponse } from 'next/og';

export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

export function AppIcon({ px }: { px: number }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#111111',
        borderRadius: px * 0.22,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: px * 0.04 }}>
        <div style={{ color: '#f5f5f5', fontSize: px * 0.42, fontWeight: 700, fontFamily: 'monospace' }}>{'>'}</div>
        <div style={{ width: px * 0.22, height: px * 0.07, background: '#d97757', borderRadius: px * 0.02, marginTop: px * 0.16 }} />
      </div>
    </div>
  );
}

export default function Icon() {
  return new ImageResponse(<AppIcon px={512} />, size);
}
