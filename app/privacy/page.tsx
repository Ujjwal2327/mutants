import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

const LAST_UPDATED = "August 18, 2026";

export const metadata: Metadata = {
  title: "Privacy Policy — Refom",
  description:
    "Refom converts files entirely inside your browser. Read exactly what does — and doesn't — ever leave your device.",
  // Each page declares its own canonical rather than inheriting the
  // homepage's; this fully replaces the root layout's alternates for this
  // route.
  alternates: {
    canonical: "/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Refom
        </Link>

        <div className="space-y-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Privacy Policy
          </h1>
          <p className="text-sm text-muted-foreground">
            Last updated {LAST_UPDATED}
          </p>
        </div>

        <div className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section className="space-y-2">
            <h2 className="text-base font-semibold text-foreground">
              The short version
            </h2>
            <p>
              Refom converts files inside your own browser tab. Your files are
              never uploaded, stored on a server, or seen by anyone at Refom —
              because there is no server in the conversion path to see them.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-foreground">
              What actually happens when you convert a file
            </h2>
            <p>
              When you drop in a file, it stays in your browser&rsquo;s memory.
              Image, PDF, spreadsheet, document, data, archive, and font
              conversions all run using your browser&rsquo;s built-in Canvas and
              File APIs. Audio and video conversions run using FFmpeg compiled
              to WebAssembly, executing entirely on your device.
            </p>
            <p>
              The one network request Refom makes on your behalf is a one-time
              download of that audio/video conversion engine from jsDelivr, a
              third-party content delivery network — that&rsquo;s the program
              that does the converting, not the file you&rsquo;re converting.
              Your browser caches it after the first use. Every other format
              makes no network request at all once the page has loaded.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-foreground">
              Cookies, accounts, and analytics
            </h2>
            <p>
              Refom doesn&rsquo;t use cookies, doesn&rsquo;t ask you to create
              an account, and doesn&rsquo;t run any analytics or advertising
              trackers. The only thing Refom stores is your light/dark theme
              preference, saved in your browser&rsquo;s local storage so
              it&rsquo;s remembered on your next visit — that preference never
              leaves your device either.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-foreground">
              Questions
            </h2>
            <p>
              Curious how a specific conversion works under the hood? The{" "}
              <Link
                href="/#how-it-works"
                className="underline underline-offset-4 hover:text-foreground"
              >
                How Refom works
              </Link>{" "}
              section on the homepage walks through it.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
