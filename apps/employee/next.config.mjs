/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The workspace packages ship compiled CommonJS with JSX already transformed,
  // but Next still needs them in its transpile set so they participate in the
  // client/server boundary analysis and the 'use client' directives are honoured.
  transpilePackages: ['@shuttle/ui', '@shuttle/client', '@shuttle/shared-types', '@shuttle/shared-utils'],

  // Behind IIS the app is served over HTTPS at a company host; standalone
  // output keeps the deployed bundle self-contained for the Windows server.
  output: 'standalone',

  // Source maps in production would expose the whole client source tree on an
  // internal-but-broadly-reachable site.
  productionBrowserSourceMaps: false,

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=()' },
        ],
      },
      {
        // The service worker must not be cached, or a deploy cannot roll out.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
