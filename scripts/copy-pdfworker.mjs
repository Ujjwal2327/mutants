// Cross-platform replacement for the old PowerShell-only copy script.
// `powershell -Command "Copy-Item ..."` only works on Windows, so on Mac/Linux
// (including most CI and deployment environments) `npm run dev` / `npm run build`
// used to fail before this file existed, leaving /public/pdf.worker.min.mjs missing
// and silently breaking the PDF -> image/text converter at runtime.

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const src = join(
  projectRoot,
  "node_modules",
  "pdfjs-dist",
  "build",
  "pdf.worker.min.mjs",
);
const destDir = join(projectRoot, "public");
const dest = join(destDir, "pdf.worker.min.mjs");

if (!existsSync(src)) {
  console.error(
    `copy-pdfworker: could not find ${src} — did "npm install" run?`,
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`copy-pdfworker: copied pdf.worker.min.mjs -> ${dest}`);
