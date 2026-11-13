import type { NextConfig } from 'next';

// HSTS is set by nginx. The UI talks to agentd via same-origin /api and /ws (routed by nginx).
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  transpilePackages: ['@mcc-agents/protocol'],
  poweredByHeader: false,
  // dev server reached through nginx / an ssh tunnel
  allowedDevOrigins: ['agents.mcc.babochkin.com', 'localhost', '127.0.0.1'],
  devIndicators: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
