import type { ReactNode } from 'react';
import { ReloadSentinel } from './reload-sentinel.tsx';

export const metadata = {
  title: 'Testa split-URL demo',
  description: '@testa/next server-side split-URL redirect demo',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          maxWidth: 640,
          margin: '3rem auto',
          padding: '0 1rem',
        }}
      >
        {children}
        <ReloadSentinel />
      </body>
    </html>
  );
}
