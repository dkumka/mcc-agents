import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'mcc agents',
    short_name: 'agents',
    description: 'Claude Code, Codex и Antigravity на сервере mcc',
    lang: 'ru',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/app-icon/192?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/app-icon/512?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/app-icon/maskable?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
