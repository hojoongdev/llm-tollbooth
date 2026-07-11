import type { Metadata } from "next";

import { Nav } from "@/components/Nav";
import { PROJECT } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLM Tollbooth",
  description: "Self-hosted LLM gateway — cost, tokens, latency and quality for every call.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">
            <span className="dot" />
            LLM Tollbooth <small>console</small>
          </div>
          <Nav />
          <div className="spacer" />
          <div className="env">project: {PROJECT}</div>
        </header>
        <main className="content">{children}</main>
      </body>
    </html>
  );
}
