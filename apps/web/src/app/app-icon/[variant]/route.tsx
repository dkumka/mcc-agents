import { ImageResponse } from 'next/og';
import { AppIconArt } from '@/lib/app-icon';

// /app-icon/192, /app-icon/512 — regular; /app-icon/maskable — 512 with a safe zone (Android adaptive icons crop ~20%)
const VARIANTS: Record<string, { size: number; maskable: boolean }> = {
  '192': { size: 192, maskable: false },
  '512': { size: 512, maskable: false },
  maskable: { size: 512, maskable: true },
};

export const dynamic = 'force-static';
export function generateStaticParams() {
  return Object.keys(VARIANTS).map((variant) => ({ variant }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ variant: string }> }) {
  const v = VARIANTS[(await params).variant] ?? VARIANTS['512'];
  return new ImageResponse(<AppIconArt px={v.size} maskable={v.maskable} rounded={false} light />, {
    width: v.size,
    height: v.size,
    headers: { 'cache-control': 'public, max-age=86400' },
  });
}
