import type { NextConfig } from 'next'

// ── Content-Security-Policy ──────────────────────────────────────────────────
// Deliberately a static, headers()-based policy rather than a per-request
// nonce. Next.js supports nonces (via `proxy.ts` — the Next 16 rename of what
// used to be `middleware.ts`), but that requires opting the whole app into
// dynamic rendering on every request, trading away the static/CDN-cacheable
// hosting this app would otherwise get for free. That trade-off buys extra
// strictness this app doesn't need: Refom has no auth, no server-held user
// data, and nothing rendered from unsanitized input. This is the static
// approach Next's own docs recommend for apps that don't need nonces,
// tightened to what Refom actually loads:
//   - `script-src`/`style-src` need 'unsafe-inline' because the App Router
//     hydrates via small inline bootstrap scripts on every page (unavoidable
//     without the nonce + forced-dynamic-rendering trade-off above), and the
//     format-picker dropdown positions its panel with an inline `style`.
//   - `script-src`/`worker-src`/`connect-src` allow `blob:` and
//     `cdn.jsdelivr.net` because audio/video conversion fetches the
//     ffmpeg.wasm engine from jsDelivr and hands it to a Worker as blob:
//     URLs (see lib/converters/ffmpeg-loader.ts). `wasm-unsafe-eval` is the
//     narrowly-scoped replacement for `unsafe-eval` needed to compile
//     WebAssembly at all (ffmpeg.wasm, pdf.js).
//   - Everything else is locked to 'none'/'self': this app has no legitimate
//     use for plugins, cross-site form posts, or being framed off-site.
// If the app later adds a login or renders untrusted HTML, revisit this with
// the nonce-based approach for the extra XSS defense-in-depth.
function buildCsp(isDev: boolean): string {
  return [
    `default-src 'self'`,
    `script-src 'self' blob: 'wasm-unsafe-eval' 'unsafe-inline'${isDev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' https://cdn.jsdelivr.net blob:`,
    `worker-src 'self' blob:`,
    `media-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'self'`,
  ].join('; ')
}

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      canvas: './empty.js',
      // wawoff2's Emscripten-generated glue code contains a Node-only
      // `require("fs")`/`require("path")` branch used to load the .wasm
      // binary from disk when running under Node. In this project the wasm
      // is embedded as an inline base64 data URI instead, so that branch is
      // genuinely dead code in the browser bundle — but Turbopack still
      // statically tries (and fails) to resolve 'fs'/'path' for it unless we
      // point it at an empty module. The `browser` condition keeps the real
      // Node builtins available for any server-side/build-time compilation.
      fs: { browser: './empty.js' },
      path: { browser: './empty.js' },
    },
  },
  // Security headers flagged by SEO/security audits (missing Referrer-Policy,
  // X-Frame-Options, X-Content-Type-Options, and Content-Security-Policy).
  // `/:path*` matches every route, including the root, so this covers the
  // HTML document and every static asset Next.js serves alongside it.
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production'
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: buildCsp(isDev) },
        ],
      },
    ]
  },
}

export default nextConfig