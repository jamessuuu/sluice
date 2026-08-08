import type { Metadata } from "next";
import "./globals.css";
import { Footer } from "@/components/footer";
import { SiteNav } from "@/components/site-nav";

const TITLE = "sluice — exactly-once side effects for agent tool calls";
const DESCRIPTION =
  "Idempotent execution, retries with a circuit breaker, durable human approval gates, and a tamper-evident audit trail. Zero runtime dependencies. Proven by a deterministic chaos harness.";

export const metadata: Metadata = {
  metadataBase: new URL("https://sluice.vercel.app"),
  title: { default: TITLE, template: "%s · sluice" },
  description: DESCRIPTION,
  icons: {
    icon: "/brand/favicon.svg",
    shortcut: "/brand/favicon.svg",
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://sluice.vercel.app",
    siteName: "sluice",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-paper text-ink antialiased">
        <SiteNav />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
