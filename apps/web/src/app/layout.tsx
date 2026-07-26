import type { Metadata, Viewport } from 'next';
import { PANEL_NAME } from '@asp/shared';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: `${PANEL_NAME} — Arma Servers That Don't Waste Your Time`,
    template: `%s — ${PANEL_NAME}`,
  },
  description:
    'Specialised hosting and control panel for Arma Reforger, Arma 3 and Arma 4. ' +
    'Accessible from any device, no coding required, live console and transparent performance.',
  applicationName: PANEL_NAME,
  robots: {
    index: true,
    follow: true,
    // The panel itself must never be indexed.
    nocache: true,
  },
  openGraph: {
    title: `${PANEL_NAME} — Arma Servers That Don't Waste Your Time`,
    description:
      'Specialised hosting for Arma Reforger, Arma 3 and Arma 4. Granular resources, live console, automatic port opening.',
    type: 'website',
  },
  // The panel is a tool, not a place to be tracked from.
  referrer: 'strict-origin-when-cross-origin',
};

export const viewport: Viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-ink-0 text-white">
        {/* Skip link: the marketing page is long and the panel is dense. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100]
                     focus:rounded focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-sm focus:font-bold"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
