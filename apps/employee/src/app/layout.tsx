import type { Metadata, Viewport } from 'next';
import { fontHref } from '@shuttle/ui/tokens';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Company Shuttle',
  description: 'Request a company shuttle pickup and track its arrival in real time.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Company Shuttle',
  appleWebApp: {
    capable: true,
    title: 'Shuttle',
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/icons/icon.svg',
    apple: '/assets/wiwynn-logo.png',
  },
  // An internal tool has no business appearing in a search index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#006090',
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom stays available: disabling it fails WCAG 1.4.4, and a
  // maximum-scale of 1 is the usual way that gets broken by accident.
  maximumScale: 5,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={fontHref} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
