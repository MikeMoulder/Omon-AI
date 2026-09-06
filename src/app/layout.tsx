import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * The tab title is a name, not a sentence. It sits next to a dozen other tabs
 * on a judge's machine and has to be findable at a glance.
 */
export const metadata: Metadata = {
  title: "Omon",
  description:
    "An AI agent that turns crypto news into trade signals, sells both over x402, and trades Binance spot and futures behind a budget layer written in plain code.",
  openGraph: {
    title: "Omon",
    description:
      "An AI agent that sells market intelligence to other agents, and trades on what it knows.",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
