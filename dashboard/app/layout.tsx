import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { AppSidebar, MobileBar } from "@/components/app-sidebar";
import { MainArea, PendingNavProvider } from "@/components/pending-nav";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LLM Tollbooth",
  description: "Self-hosted LLM gateway — cost, tokens, latency and quality for every call.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-svh">
        <ThemeProvider>
          <PendingNavProvider>
            <div className="flex min-h-svh flex-col md:flex-row">
              <MobileBar />
              <AppSidebar />
              <MainArea>{children}</MainArea>
            </div>
          </PendingNavProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
