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

const TITLE = "Basis — tokenized stock price gaps on Solana";
const DESCRIPTION =
  "Every tokenized stock on Solana trades at a price that is not the price of the thing it tracks. Basis shows the gap live, splits it into the part a swap can capture and the part it cannot, and only offers a trade where one genuinely exists.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  metadataBase: new URL("https://basis-terminal.vercel.app"),
  applicationName: "Basis",
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://basis-terminal.vercel.app",
    siteName: "Basis",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
