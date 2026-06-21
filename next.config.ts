import type { NextConfig } from 'next'

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
}

export default nextConfig