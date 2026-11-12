import { ImageResponse } from 'next/og';
import { AppIconArt } from '@/lib/app-icon';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// iOS rounds the corners itself — draw a full square
export default function AppleIcon() {
  return new ImageResponse(<AppIconArt px={180} rounded={false} />, size);
}
