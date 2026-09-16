import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui/toaster';
import { getSettings } from '@/lib/settings';

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings().catch(() => null);
  const name = String(settings?.['platform.name'] || 'SME Lending');
  return {
    title: { default: name, template: `%s | ${name}` },
    description: `${name} — small business lending.`,
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0B1220',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
