#!/usr/bin/env node
// Render icon PNGs from the SVG sources using @resvg/resvg-js.
//
// Why resvg and not ImageMagick? ImageMagick's built-in SVG renderer does not
// support <pattern> fills (or feDropShadow), so the card-back texture came out
// solid black. resvg handles patterns, transforms, and filters correctly.
//
// Usage: node icons/_regen.mjs
// Requires: node + @resvg/resvg-js (see icons/_regen.sh, which installs it).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const requireHere = createRequire(join(here, "package.json"));

let Resvg;
try {
  ({ Resvg } = requireHere("@resvg/resvg-js"));
} catch {
  // Allow _regen.sh to install deps into icons/.regen-deps instead.
  const fallback = createRequire(join(here, ".regen-deps", "package.json"));
  ({ Resvg } = fallback("@resvg/resvg-js"));
}

const jobs = [
  ["icon-source.svg", "favicon-32.png", 32],
  ["icon-source.svg", "apple-touch-icon.png", 180],
  ["icon-source.svg", "icon-192.png", 192],
  ["icon-source.svg", "icon-512.png", 512],
  ["icon-maskable-source.svg", "icon-maskable-512.png", 512],
];

for (const [src, out, size] of jobs) {
  const svg = readFileSync(join(here, src), "utf8");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  });
  writeFileSync(join(here, out), resvg.render().asPng());
  console.log(`wrote ${out} (${size}x${size})`);
}
