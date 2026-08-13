import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Outfit is bundled locally (app/fonts/Outfit.woff2, variable 100–900, latin)
// instead of next/font/google so the production build does NOT need to reach
// fonts.googleapis.com at build time — builds stay reliable on flaky/offline nets.
const fontSans = localFont({
  src: "./fonts/Outfit.woff2",
  variable: "--font-sans",
  weight: "100 900",
  display: "swap"
});

export const metadata: Metadata = {
  title: "AmpCore",
  description: "Control and monitor your amplifier system",
  icons: {
    icon: "/logo.ico"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={fontSans.variable}>
      <head />
      <body className={`${fontSans.variable} h-screen overflow-hidden antialiased bg-background`}>{children}</body>
    </html>
  );
}
