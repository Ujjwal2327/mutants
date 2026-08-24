import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

// TODO: point this at the real production domain (or set NEXT_PUBLIC_SITE_URL
// in the deploy environment) — it seeds metadataBase, which every absolute
// URL below (canonical link, Open Graph/Twitter URLs) is resolved against.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://refom.app";

const TITLE =
  "Refom – Free Online File Converter for Images, PDF, Audio & Video";
const DESCRIPTION =
  "Convert images, PDFs, documents, spreadsheets, archives, fonts, audio, and video for free — entirely in your browser. No uploads, no sign-up, nothing leaves your device.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  // Fixes "Canonicals: Missing" — every page should declare its own
  // canonical so search engines don't have to guess between URL variants.
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    siteName: "Refom",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster position="bottom-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
