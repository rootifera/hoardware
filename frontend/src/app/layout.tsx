import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";
import { AuthGate } from "@/components/auth-gate";
import { AppShell } from "@/components/app-shell";
import { SetupGate } from "@/components/setup-gate";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: { default: "Hoardware", template: "%s · Hoardware" },
  description: "Know what you own, where it is, and whether it works.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Providers>
          <AuthGate>
            <SetupGate>
              <AppShell>{children}</AppShell>
            </SetupGate>
          </AuthGate>
        </Providers>
      </body>
    </html>
  );
}
