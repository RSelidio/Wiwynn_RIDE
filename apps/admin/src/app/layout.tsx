import type { Metadata, Viewport } from 'next';
import { fontHref } from '@shuttle/ui/tokens';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Shuttle Admin',
  description: 'Live monitoring, dispatch and reporting for the company shuttle service.',
  icons: { icon: '/assets/wiwynn-logo.png' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#006090',
  width: 'device-width',
  initialScale: 1,
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
